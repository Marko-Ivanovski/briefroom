import type { TokenSummary } from '@briefroom/contracts';
import { authSchema, type Db } from '@briefroom/db';
import { Inject, Injectable, NotFoundException, type OnModuleInit } from '@nestjs/common';
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

  async create(scope: Scope, name: string): Promise<{ id: string; token: string }> {
    const created = await this.auth.api.createApiKey({
      body: { name, userId: scope.userId, metadata: { workspaceId: scope.workspaceId } },
    });
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
      .select({ id: authSchema.member.id })
      .from(authSchema.member)
      .where(
        and(
          eq(authSchema.member.userId, key.referenceId),
          eq(authSchema.member.organizationId, workspaceId),
        ),
      )
      .limit(1);
    if (!member) return null;
    return { userId: key.referenceId, workspaceId, tokenId: key.id };
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
