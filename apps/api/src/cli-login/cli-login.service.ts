import { createHash, randomBytes, randomInt } from 'node:crypto';
import {
  CLI_LOGIN_POLL_INTERVAL_SECONDS,
  CLI_LOGIN_TTL_MS,
  type CliLoginApprove,
  type CliLoginApproved,
  type CliLoginPreviewed,
  type CliLoginPollResult,
  type CliLoginStarted,
} from '@briefroom/contracts';
import {
  authSchema,
  cliLogins,
  tokenCutoffs,
  createdStamp,
  updatedStamp,
  type Actor,
  type Db,
} from '@briefroom/db';
import {
  UnauthorizedException,
  type OnModuleInit,
  GoneException,
  Inject,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { and, eq, gt, inArray, lt } from 'drizzle-orm';
import { AccessService } from '../access/access.service.ts';
import { DB } from '../database/database.module.ts';
import { hasPgCode } from '../errors/pg-error.ts';
import { RevocationService } from '../members/revocation.service.ts';
import { InstallService } from '../install/install.service.ts';
import { TunnelState } from '../remote-access/tunnel-state.ts';
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
function clean(raw: string | undefined, max: number): string {
  return (raw ?? '')
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, '')
    .trim()
    .slice(0, max)
    .trim();
}

export function sanitiseDeviceName(raw: string | undefined): string {
  return clean(raw, MAX_DEVICE_NAME) || DEFAULT_DEVICE_NAME;
}

export interface StartOrigin {
  ip: string | undefined;
  userAgent: string | undefined;
}

/**
 * The device-code handshake for `briefroom login`. The token is minted by the poll, through
 * TokensService.create, so no plaintext token ever sits in cli_logins: the row only records who
 * approved and which workspace, and which token id was minted.
 */
@Injectable()
export class CliLoginService implements OnModuleInit {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly tunnel: TunnelState,
    private readonly access: AccessService,
    private readonly tokens: TokensService,
    private readonly installs: InstallService,
    private readonly revocation: RevocationService,
  ) {}

  // An approval is only a promise to mint a token. A password reset or a removal must break it.
  onModuleInit(): void {
    this.revocation.onPasswordReset((userId) => this.deny(eq(cliLogins.userId, userId)));
    this.revocation.onMemberRemoved((workspaceId, userId) =>
      this.deny(and(eq(cliLogins.userId, userId), eq(cliLogins.workspaceId, workspaceId))),
    );
  }

  private async deny(match: ReturnType<typeof eq> | ReturnType<typeof and>): Promise<void> {
    await this.db
      .update(cliLogins)
      .set({ status: 'denied', ...updatedStamp(CLI_ACTOR) })
      .where(and(match, inArray(cliLogins.status, ['pending', 'approved'])));
  }

  async start(rawDeviceName: string | undefined, origin: StartOrigin): Promise<CliLoginStarted> {
    // Cleanup is lazy: every new login sweeps the expired ones, so the table stays small.
    const now = new Date();
    await this.db.delete(cliLogins).where(lt(cliLogins.expiresAt, now));
    const pollToken = randomBytes(32).toString('base64url');
    const expiresAt = new Date(now.getTime() + CLI_LOGIN_TTL_MS);
    const deviceName = sanitiseDeviceName(rawDeviceName);
    for (let attempt = 0; attempt < MAX_CODE_ATTEMPTS; attempt++) {
      const code = generateLoginCode();
      try {
        await this.db.insert(cliLogins).values({
          code,
          pollTokenHash: hashPollToken(pollToken),
          deviceName,
          startIp: clean(origin.ip, 64) || null,
          startUserAgent: clean(origin.userAgent, 200) || null,
          expiresAt,
          ...createdStamp(CLI_ACTOR),
          createdAt: now,
          updatedAt: now,
        });
      } catch (err) {
        if (hasPgCode(err, '23505')) continue;
        throw err;
      }
      return {
        code,
        approveUrl: `${this.tunnel.publicUrl()}/connect`,
        pollToken,
        expiresAt: expiresAt.toISOString(),
        interval: CLI_LOGIN_POLL_INTERVAL_SECONDS,
      };
    }
    throw new InternalServerErrorException('Could not create a login code');
  }

  async approve(
    userId: string,
    sessionId: string,
    body: CliLoginApprove,
  ): Promise<CliLoginApproved> {
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
        approvedAt: new Date(),
        approvedSessionId: sessionId,
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

  /** Read-only: no row is stamped. Every non-pending state answers the one 404 so codes cannot be probed. */
  async preview(code: string, approverIp: string | undefined): Promise<CliLoginPreviewed> {
    const [row] = await this.db
      .select()
      .from(cliLogins)
      .where(
        and(
          eq(cliLogins.code, code),
          eq(cliLogins.status, 'pending'),
          gt(cliLogins.expiresAt, new Date()),
        ),
      );
    if (!row) throw new NotFoundException({ code: 'not_found', message: 'Login code not found' });
    const now = Date.now();
    return {
      deviceName: row.deviceName,
      startedSecondsAgo: Math.max(0, Math.floor((now - row.createdAt.getTime()) / 1000)),
      expiresInSeconds: Math.max(0, Math.floor((row.expiresAt.getTime() - now) / 1000)),
      startIp: row.startIp,
      startUserAgent: row.startUserAgent,
      sameIpAsYou: !!approverIp && row.startIp === approverIp,
    };
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

  // Same rules TokensService.verify applies to a key: a reset cutoff or a newer membership kills it.
  private async approvalIsStale(
    userId: string,
    workspaceId: string,
    approvedAt: Date,
  ): Promise<boolean> {
    const [member] = await this.db
      .select({ joinedAt: authSchema.member.createdAt })
      .from(authSchema.member)
      .where(
        and(
          eq(authSchema.member.userId, userId),
          eq(authSchema.member.organizationId, workspaceId),
        ),
      );
    if (!member || approvedAt.getTime() <= member.joinedAt.getTime()) return true;
    const [cutoff] = await this.db
      .select({ validAfter: tokenCutoffs.validAfter })
      .from(tokenCutoffs)
      .where(eq(tokenCutoffs.userId, userId));
    return !!cutoff && cutoff.validAfter.getTime() >= approvedAt.getTime();
  }

  private async issue(row: typeof cliLogins.$inferSelect): Promise<CliLoginPollResult> {
    if (!row.userId || !row.workspaceId) return EXPIRED;
    // Membership is read again: someone removed after approving gets no token.
    const scope = await this.access.scopeFor(row.userId, row.workspaceId, 'cli');
    if (!scope) return EXPIRED;
    if (!row.approvedAt || !row.approvedSessionId) return EXPIRED;
    if (await this.approvalIsStale(row.userId, row.workspaceId, row.approvedAt)) return EXPIRED;
    let created: { id: string; token: string };
    try {
      created = await this.tokens.create(
        scope,
        `CLI: ${row.deviceName}`.slice(0, MAX_DEVICE_NAME),
        row.approvedSessionId,
      );
    } catch (err) {
      // The approving session ended: tokens.create already removed the key it made.
      if (err instanceof UnauthorizedException) return EXPIRED;
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
      baseUrl: this.tunnel.publicUrl(),
    };
  }
}
