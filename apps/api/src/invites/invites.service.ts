import { createHash, randomBytes } from 'node:crypto';
import type { InviteCreate, InviteCreated, InviteSummary, JoinLookup } from '@briefroom/contracts';
import {
  authSchema,
  inviteLinks,
  projects,
  scoped,
  scopedInsert,
  scopedProjects,
  type Db,
} from '@briefroom/db';
import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, desc, eq, inArray, isNull, gt, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Scope } from '../access/scope.ts';
import { ENV, type Env } from '../config/env.ts';
import { DB } from '../database/database.module.ts';
import { ReachService } from '../install/reach.service.ts';
import { revokeLinks } from './revoke-links.ts';

const DAY_MS = 24 * 60 * 60 * 1000;
const NOT_FOUND = { code: 'not_found', message: 'Invite link not found' };
const uuid = z.uuid();

export function hashInviteToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export const isActive = () =>
  and(
    isNull(inviteLinks.revokedAt),
    gt(inviteLinks.expiresAt, sql`now()`),
    or(isNull(inviteLinks.maxUses), sql`${inviteLinks.uses} < ${inviteLinks.maxUses}`),
  );

@Injectable()
export class InvitesService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(ENV) private readonly env: Env,
    private readonly reach: ReachService,
  ) {}

  async create(scope: Scope, input: InviteCreate): Promise<InviteCreated> {
    const projectIds = [...new Set(input.projectIds)];
    await this.assertProjectsInWorkspace(scope, projectIds);
    return this.insert(this.db, scope, { ...input, projectIds }, input.expiresInDays * DAY_MS);
  }

  async list(scope: Scope): Promise<InviteSummary[]> {
    const rows = await this.db
      .select({ link: inviteLinks, creator: authSchema.user.name })
      .from(inviteLinks)
      .leftJoin(authSchema.user, eq(authSchema.user.id, inviteLinks.createdBy))
      .where(and(scoped(scope, inviteLinks), isActive()))
      .orderBy(desc(inviteLinks.createdAt), desc(inviteLinks.id));
    return rows.map(({ link, creator }) => ({
      id: link.id,
      role: link.role,
      expiresAt: link.expiresAt.toISOString(),
      maxUses: link.maxUses,
      uses: link.uses,
      requiresApproval: link.requiresApproval,
      projectIds: link.projectIds,
      createdBy: creator ?? '',
      createdAt: link.createdAt.toISOString(),
    }));
  }

  async revoke(scope: Scope, id: string): Promise<void> {
    if (!uuid.safeParse(id).success) throw new NotFoundException(NOT_FOUND);
    const revoked = await this.db.transaction((tx) => this.markRevoked(tx, scope, id));
    if (!revoked) throw new NotFoundException(NOT_FOUND);
  }

  async regenerate(scope: Scope, id: string): Promise<InviteCreated> {
    if (!uuid.safeParse(id).success) throw new NotFoundException(NOT_FOUND);
    return this.db.transaction(async (tx) => {
      const old = await this.markRevoked(tx, scope, id);
      if (!old) throw new NotFoundException(NOT_FOUND);
      const days = Math.max(
        1,
        Math.round((old.expiresAt.getTime() - old.createdAt.getTime()) / DAY_MS),
      );
      return this.insert(tx, scope, old, days * DAY_MS);
    });
  }

  async lookup(token: string): Promise<JoinLookup> {
    const [row] = await this.db
      .select({
        workspaceId: inviteLinks.workspaceId,
        workspaceName: authSchema.organization.name,
        role: inviteLinks.role,
        requiresApproval: inviteLinks.requiresApproval,
      })
      .from(inviteLinks)
      .innerJoin(authSchema.organization, eq(authSchema.organization.id, inviteLinks.workspaceId))
      .where(and(eq(inviteLinks.tokenHash, hashInviteToken(token)), isActive()));
    return row ? { valid: true, ...row } : { valid: false };
  }

  private async assertProjectsInWorkspace(scope: Scope, ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const found = await this.db
      .select({ id: projects.id })
      .from(projects)
      .where(and(scopedProjects(scope), inArray(projects.id, ids)));
    if (found.length !== ids.length) {
      throw new BadRequestException({
        code: 'invalid_project',
        message: 'One or more projects are not in this workspace.',
      });
    }
  }

  private async insert(
    db: Pick<Db, 'insert'>,
    scope: Scope,
    settings: Pick<InviteCreate, 'role' | 'maxUses' | 'requiresApproval' | 'projectIds'>,
    ttlMs: number,
  ): Promise<InviteCreated> {
    const token = randomBytes(32).toString('base64url');
    const [row] = await db
      .insert(inviteLinks)
      .values(
        scopedInsert(scope, {
          tokenHash: hashInviteToken(token),
          role: settings.role,
          expiresAt: new Date(Date.now() + ttlMs),
          maxUses: settings.maxUses,
          // R87: a leaked admin link must never make someone an admin without approval.
          requiresApproval: settings.role === 'admin' || settings.requiresApproval,
          projectIds: settings.projectIds,
        }),
      )
      .returning({ id: inviteLinks.id, expiresAt: inviteLinks.expiresAt });
    return {
      id: row!.id,
      url: `${this.env.publicUrl}/join/${token}`,
      expiresAt: row!.expiresAt.toISOString(),
      ...(this.reach.isReachableByOthers() ? {} : { warning: 'install_not_reachable' as const }),
    };
  }

  /** Revokes one link in this workspace that is not revoked yet, and declines its pending requests. */
  private async markRevoked(db: Pick<Db, 'update'>, scope: Scope, id: string) {
    const [row] = await revokeLinks(db, scope, eq(inviteLinks.id, id));
    return row;
  }
}
