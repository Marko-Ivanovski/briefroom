import { createHash, randomBytes, randomInt } from 'node:crypto';
import {
  CLI_LOGIN_POLL_INTERVAL_SECONDS,
  CLI_LOGIN_TTL_MS,
  type CliLoginApprove,
  type CliLoginApproved,
  type CliLoginPollResult,
  type CliLoginStarted,
} from '@briefroom/contracts';
import {
  authSchema,
  cliLogins,
  createdStamp,
  updatedStamp,
  type Actor,
  type Db,
} from '@briefroom/db';
import {
  GoneException,
  Inject,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { and, eq, gt, lt } from 'drizzle-orm';
import { AccessService } from '../access/access.service.ts';
import { ENV, type Env } from '../config/env.ts';
import { DB } from '../database/database.module.ts';
import { hasPgCode } from '../errors/pg-error.ts';
import { InstallService } from '../install/install.service.ts';
import { TokensService } from '../tokens/tokens.service.ts';

// No 0, O, 1, I or L, so a code read aloud or typed from a screen is not misread.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const DEFAULT_DEVICE_NAME = 'Briefroom CLI';
const MAX_DEVICE_NAME = 80;
const MAX_CODE_ATTEMPTS = 5;
// The caller of start and poll has no account yet.
const CLI_ACTOR: Actor = { userId: 'cli-login', via: 'cli' };
const EXPIRED: CliLoginPollResult = { status: 'expired' };

export function generateLoginCode(): string {
  const pick = () => ALPHABET[randomInt(ALPHABET.length)]!;
  return `${Array.from({ length: 4 }, pick).join('')}-${Array.from({ length: 4 }, pick).join('')}`;
}

export function hashPollToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

// Control and format characters are dropped so a device name cannot reorder or hide text on the approval page.
export function sanitiseDeviceName(raw: string | undefined): string {
  const cleaned = (raw ?? '').replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, '').trim();
  return cleaned.slice(0, MAX_DEVICE_NAME).trim() || DEFAULT_DEVICE_NAME;
}

/**
 * The device-code handshake for `briefroom login`. The token is minted by the poll, through
 * TokensService.create, so no plaintext token ever sits in cli_logins: the row only records who
 * approved and which workspace, and which token id was minted.
 */
@Injectable()
export class CliLoginService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(ENV) private readonly env: Env,
    private readonly access: AccessService,
    private readonly tokens: TokensService,
    private readonly installs: InstallService,
  ) {}

  async start(rawDeviceName: string | undefined): Promise<CliLoginStarted> {
    // Cleanup is lazy: every new login sweeps the expired ones, so the table stays small.
    await this.db.delete(cliLogins).where(lt(cliLogins.expiresAt, new Date()));
    const pollToken = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + CLI_LOGIN_TTL_MS);
    const deviceName = sanitiseDeviceName(rawDeviceName);
    for (let attempt = 0; attempt < MAX_CODE_ATTEMPTS; attempt++) {
      const code = generateLoginCode();
      try {
        await this.db.insert(cliLogins).values({
          code,
          pollTokenHash: hashPollToken(pollToken),
          deviceName,
          expiresAt,
          ...createdStamp(CLI_ACTOR),
        });
      } catch (err) {
        if (hasPgCode(err, '23505')) continue;
        throw err;
      }
      return {
        code,
        approveUrl: `${this.env.publicUrl}/connect?code=${code}`,
        pollToken,
        expiresAt: expiresAt.toISOString(),
        interval: CLI_LOGIN_POLL_INTERVAL_SECONDS,
      };
    }
    throw new InternalServerErrorException('Could not create a login code');
  }

  async approve(userId: string, body: CliLoginApprove): Promise<CliLoginApproved> {
    // Membership first, so a non-member learns nothing about whether the code exists.
    const scope = await this.access.scopeFor(userId, body.workspaceId, 'web');
    if (!scope) throw new NotFoundException();
    const [workspace] = await this.db
      .select({ name: authSchema.organization.name })
      .from(authSchema.organization)
      .where(eq(authSchema.organization.id, body.workspaceId));
    if (!workspace) throw new NotFoundException();

    // One conditional update makes approval single use even when two approvals race.
    const [row] = await this.db
      .update(cliLogins)
      .set({
        status: 'approved',
        userId,
        workspaceId: body.workspaceId,
        ...updatedStamp({ userId, via: 'web' }),
      })
      .where(
        and(
          eq(cliLogins.code, body.code),
          eq(cliLogins.status, 'pending'),
          gt(cliLogins.expiresAt, new Date()),
        ),
      )
      .returning({ deviceName: cliLogins.deviceName, createdAt: cliLogins.createdAt });
    if (row) {
      return {
        deviceName: row.deviceName,
        startedAt: row.createdAt.toISOString(),
        workspaceName: workspace.name,
      };
    }
    const [known] = await this.db
      .select({ id: cliLogins.id })
      .from(cliLogins)
      .where(eq(cliLogins.code, body.code));
    if (!known) throw new NotFoundException();
    throw new GoneException({
      code: 'cli_login_closed',
      message: 'This login code expired or was already used. Start again with briefroom login.',
    });
  }

  /** Unknown, expired, denied, consumed and revoked logins all answer the same, so a poll token reveals nothing. */
  async poll(pollToken: string): Promise<CliLoginPollResult> {
    const hash = hashPollToken(pollToken);
    const live = and(eq(cliLogins.pollTokenHash, hash), gt(cliLogins.expiresAt, new Date()));
    // Claiming flips approved to consumed in one statement, so two polls can never both mint a token.
    const [claimed] = await this.db
      .update(cliLogins)
      .set({ status: 'consumed', ...updatedStamp(CLI_ACTOR) })
      .where(and(live, eq(cliLogins.status, 'approved')))
      .returning();
    if (claimed) return this.issue(claimed);

    const [pending] = await this.db
      .select({ id: cliLogins.id })
      .from(cliLogins)
      .where(and(live, eq(cliLogins.status, 'pending')));
    return pending ? { status: 'pending' } : EXPIRED;
  }

  private async issue(row: typeof cliLogins.$inferSelect): Promise<CliLoginPollResult> {
    if (!row.userId || !row.workspaceId) return EXPIRED;
    // Membership is read again: someone removed after approving gets no token.
    const scope = await this.access.scopeFor(row.userId, row.workspaceId, 'cli');
    if (!scope) return EXPIRED;
    let created: { id: string; token: string };
    try {
      created = await this.tokens.create(scope, `CLI: ${row.deviceName}`.slice(0, MAX_DEVICE_NAME));
    } catch (err) {
      // Nothing was handed out, so the approval stays usable for the CLI's next poll.
      await this.db
        .update(cliLogins)
        .set({ status: 'approved', ...updatedStamp(CLI_ACTOR) })
        .where(eq(cliLogins.id, row.id));
      throw err;
    }
    await this.db
      .update(cliLogins)
      .set({ tokenId: created.id, ...updatedStamp({ userId: row.userId, via: 'cli' }) })
      .where(eq(cliLogins.id, row.id));
    const [workspace] = await this.db
      .select({ name: authSchema.organization.name })
      .from(authSchema.organization)
      .where(eq(authSchema.organization.id, row.workspaceId));
    return {
      status: 'approved',
      token: created.token,
      workspaceId: row.workspaceId,
      workspaceName: workspace?.name ?? '',
      installId: (await this.installs.getRow()).id,
      baseUrl: this.env.publicUrl,
    };
  }
}
