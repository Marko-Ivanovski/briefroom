import type { TokenSummary } from '@briefroom/contracts';
import { authSchema, createdStamp, tokenCutoffs, type Db, updatedStamp } from '@briefroom/db';
import {
  Inject,
  Injectable,
  NotFoundException,
  UnauthorizedException,
  type OnModuleInit,
} from '@nestjs/common';
import { and, eq, inArray } from 'drizzle-orm';
import type { Scope } from '../access/scope.ts';
import { AUTH } from '../auth/auth.module.ts';
import type { Auth } from '../auth/auth.ts';
import { DB } from '../database/database.module.ts';
import { RevocationService } from '../members/revocation.service.ts';

export interface VerifiedToken {
  userId: string;
  workspaceId: string;
  tokenId: string;
}

// Better Auth stores metadata as a JSON string, and has been seen to stringify it twice.
function workspaceIdOf(metadata: unknown): string | null {
  let value = metadata;
  for (let i = 0; i < 2 && typeof value === 'string'; i++) {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (typeof value !== 'object' || value === null) return null;
  const id = (value as { workspaceId?: unknown }).workspaceId;
  return typeof id === 'string' && id !== '' ? id : null;
}

/**
 * Workspace tokens are Better Auth API keys (R144): hashed at rest, tied to one user, and tagged
 * with one workspace in metadata. The key list and delete endpoints need a session, which a
 * server call does not have, so those two read and write the key table directly.
 */
@Injectable()
export class TokensService implements OnModuleInit {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(AUTH) private readonly auth: Auth,
    private readonly revocation: RevocationService,
  ) {}

  onModuleInit(): void {
    this.revocation.onMemberRemoved((workspaceId, userId) => this.revokeFor(userId, workspaceId));
    // R149: only a password reset ends all of a user's tokens, not sign-out or other session cleanup.
    this.revocation.onPasswordReset((userId) => this.revokeFor(userId));
  }

  // sessionId is the session that authorised the request. A reset can delete it after the guard
  // passed and before the insert, so it is checked again once the key exists.
  async create(
    scope: Scope,
    name: string,
    sessionId?: string,
  ): Promise<{ id: string; token: string }> {
    const created = await this.auth.api.createApiKey({
      body: { name, userId: scope.userId, metadata: { workspaceId: scope.workspaceId } },
    });
    if (sessionId !== undefined && !(await this.sessionExists(sessionId))) {
      await this.db.delete(authSchema.apikey).where(eq(authSchema.apikey.id, created.id));
      throw new UnauthorizedException();
    }
    return { id: created.id, token: created.key };
  }

  // Checked on every call and never cached: membership is read live, so a removed member's token
  // stops working even if the revocation handler has not run yet.
  async verify(token: string): Promise<VerifiedToken | null> {
    if (typeof token !== 'string' || token === '') return null;
    let result;
    try {
      result = await this.auth.api.verifyApiKey({ body: { key: token } });
    } catch {
      return null;
    }
    const key = result.valid ? result.key : null;
    if (!key || key.enabled === false) return null;
    const workspaceId = workspaceIdOf(key.metadata);
    if (!workspaceId) return null;
    const [member] = await this.db
      .select({ id: authSchema.member.id, joinedAt: authSchema.member.createdAt })
      .from(authSchema.member)
      .where(
        and(
          eq(authSchema.member.userId, key.referenceId),
          eq(authSchema.member.organizationId, workspaceId),
        ),
      )
      .limit(1);
    if (!member) return null;
    // A key made under an earlier membership stays dead after a rejoin, which adds a new member row.
    // A role change updates the row in place, so it keeps its tokens.
    if (new Date(key.createdAt).getTime() <= member.joinedAt.getTime()) return null;
    if (await this.predatesCutoff(key.referenceId, key.createdAt)) return null;
    return { userId: key.referenceId, workspaceId, tokenId: key.id };
  }

  /**
   * Fail-closed part of a password reset (R151): every token created up to now stops verifying.
   * It throws on failure so the reset is refused. Deleting the rows afterwards is only cleanup.
   * The cutoff and a key's createdAt both come from the app clock (Better Auth stamps keys with
   * new Date()), so they compare on one clock.
   */
  async invalidateAll(userId: string): Promise<void> {
    const actor = { userId: 'reset-link', via: 'web' } as const;
    const validAfter = new Date();
    await this.db
      .insert(tokenCutoffs)
      .values({ userId, validAfter, ...createdStamp(actor) })
      .onConflictDoUpdate({
        target: tokenCutoffs.userId,
        set: { validAfter, ...updatedStamp(actor) },
      });
  }

  private async sessionExists(sessionId: string): Promise<boolean> {
    const [row] = await this.db
      .select({ id: authSchema.session.id })
      .from(authSchema.session)
      .where(eq(authSchema.session.id, sessionId))
      .limit(1);
    return !!row;
  }

  private async predatesCutoff(userId: string, createdAt: Date | string): Promise<boolean> {
    const [cutoff] = await this.db
      .select({ validAfter: tokenCutoffs.validAfter })
      .from(tokenCutoffs)
      .where(eq(tokenCutoffs.userId, userId));
    return !!cutoff && new Date(createdAt).getTime() <= cutoff.validAfter.getTime();
  }

  async list(scope: Scope): Promise<TokenSummary[]> {
    const rows = await this.ownKeys(scope.userId, scope.workspaceId);
    return rows
      .map((r) => ({
        id: r.id,
        name: r.name ?? '',
        createdAt: r.createdAt.toISOString(),
        lastUsedAt: r.lastRequest ? r.lastRequest.toISOString() : null,
      }))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async remove(scope: Scope, id: string): Promise<void> {
    const own = (await this.ownKeys(scope.userId, scope.workspaceId)).find((r) => r.id === id);
    if (!own) throw new NotFoundException({ code: 'not_found', message: 'Token not found' });
    await this.db.delete(authSchema.apikey).where(eq(authSchema.apikey.id, own.id));
  }

  private async ownKeys(userId: string, workspaceId: string) {
    const rows = await this.db
      .select()
      .from(authSchema.apikey)
      .where(eq(authSchema.apikey.referenceId, userId));
    return rows.filter((r) => workspaceIdOf(r.metadata) === workspaceId);
  }

  private async revokeFor(userId: string, workspaceId?: string): Promise<void> {
    const rows = await this.db
      .select()
      .from(authSchema.apikey)
      .where(eq(authSchema.apikey.referenceId, userId));
    const ids = rows
      .filter((r) => workspaceId === undefined || workspaceIdOf(r.metadata) === workspaceId)
      .map((r) => r.id);
    if (ids.length > 0) {
      await this.db.delete(authSchema.apikey).where(inArray(authSchema.apikey.id, ids));
    }
  }
}
