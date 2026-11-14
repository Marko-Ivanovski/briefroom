import { Role, type MemberSummary, type RemovalResult } from '@briefroom/contracts';
import {
  authSchema,
  inviteLinks,
  memberPermissions,
  passwordResetLinks,
  projectAccessChecklist,
  projects,
  scopedInsert,
  updatedStamp,
  workspaceRemovals,
  type Db,
} from '@briefroom/db';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { and, asc, count, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import type { Scope } from '../access/scope.ts';
import { AUTH } from '../auth/auth.module.ts';
import type { Auth } from '../auth/auth.ts';
import { hasPgCode } from '../errors/pg-error.ts';
import { describeError } from '../errors/safe-error.ts';
import { DB } from '../database/database.module.ts';
import { ProjectMembersService } from '../projects/project-members.service.ts';
import { revokeLinks } from '../invites/revoke-links.ts';
import { RevocationService } from './revocation.service.ts';

const PG_DEADLOCK = '40P01';
const PG_SERIALIZATION = '40001';

@Injectable()
export class MembersService {
  private readonly log = new Logger(MembersService.name);

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(AUTH) private readonly auth: Auth,
    private readonly projectMembers: ProjectMembersService,
    private readonly revocation: RevocationService,
  ) {}

  async list(scope: Scope): Promise<MemberSummary[]> {
    return this.select(scope.workspaceId);
  }

  // Role changes and leaving go through Better Auth's server API with the acting user's headers, so
  // its own organization permission checks run as a second layer behind the rules here.
  async changeRole(
    scope: Scope,
    headers: Headers,
    targetUserId: string,
    role: 'admin' | 'member',
  ): Promise<MemberSummary> {
    const [target] = await this.db
      .select({ id: authSchema.member.id, role: authSchema.member.role })
      .from(authSchema.member)
      .where(
        and(
          eq(authSchema.member.organizationId, scope.workspaceId),
          eq(authSchema.member.userId, targetUserId),
        ),
      );
    if (!target) throw new NotFoundException('Member not found');
    if (target.role === 'owner') throw new ConflictException("The owner's role cannot be changed");

    // Only the owner demotes: an admin who could demote another admin could then issue a reset
    // link for them and take the account back over.
    if (target.role === 'admin' && role === 'member' && scope.role !== 'owner') {
      throw new ForbiddenException('Only the owner can demote an admin');
    }

    await this.auth.api.updateMemberRole({
      headers,
      body: { memberId: target.id, role, organizationId: scope.workspaceId },
    });
    // Admin-issued links were authorised against the old role. Removal (Task 4.3) must do the same.
    await this.db
      .update(passwordResetLinks)
      .set({ usedAt: sql`now()`, ...updatedStamp(scope.actor) })
      .where(
        and(
          eq(passwordResetLinks.userId, targetUserId),
          isNotNull(passwordResetLinks.workspaceId),
          isNull(passwordResetLinks.usedAt),
        ),
      );
    const [updated] = await this.select(scope.workspaceId, targetUserId);
    if (!updated) throw new NotFoundException('Member not found');
    return updated;
  }

  async leave(scope: Scope): Promise<void> {
    await this.revoke(scope, scope.userId, 'leave');
  }

  async remove(scope: Scope, targetUserId: string): Promise<RemovalResult> {
    const projectIds = await this.revoke(scope, targetUserId, 'remove');
    return { projects: await this.pendingRemovals(scope, projectIds, targetUserId) };
  }

  private async pendingRemovals(
    scope: Scope,
    projectIds: string[],
    userId: string,
  ): Promise<RemovalResult['projects']> {
    if (projectIds.length === 0) return [];
    const rows = await this.db
      .select({ id: projects.id, name: projects.name, undone: count() })
      .from(projectAccessChecklist)
      .innerJoin(projects, eq(projects.id, projectAccessChecklist.projectId))
      .where(
        and(
          eq(projectAccessChecklist.workspaceId, scope.workspaceId),
          eq(projectAccessChecklist.userId, userId),
          eq(projectAccessChecklist.kind, 'remove'),
          eq(projectAccessChecklist.done, false),
          inArray(projectAccessChecklist.projectId, projectIds),
        ),
      )
      .groupBy(projects.id, projects.name)
      .orderBy(asc(projects.name));
    return rows;
  }

  /**
   * Shared by removal and leaving. Better Auth's server API is deliberately not used here: it takes
   * a second pooled connection, which could exhaust the pool and cannot join our transaction. Our
   * own rules are the primary layer (R42), so everything runs in one transaction on one connection
   * and either all of it applies or none. Past records are untouched: `created_by` and
   * `updated_by` are never rewritten.
   */
  private async revoke(scope: Scope, userId: string, mode: 'remove' | 'leave'): Promise<string[]> {
    const projectIds = await this.transact<string[]>(async (tx) => {
      // Both rows are locked by one statement in user_id order, so two people removing each other
      // queue up instead of deadlocking. Roles are read under the lock, so a concurrent demotion or
      // promotion cannot slip past the rules below.
      const locked = await tx
        .select({
          userId: authSchema.member.userId,
          id: authSchema.member.id,
          role: authSchema.member.role,
        })
        .from(authSchema.member)
        .where(
          and(
            eq(authSchema.member.organizationId, scope.workspaceId),
            inArray(authSchema.member.userId, [...new Set([userId, scope.userId])]),
          ),
        )
        .orderBy(asc(authSchema.member.userId))
        .for('update');
      const target = locked.find((m) => m.userId === userId);
      if (!target) throw new NotFoundException('Member not found');

      let callerRole = scope.role;
      if (mode === 'remove') {
        const caller = locked.find((m) => m.userId === scope.userId);
        if (caller?.role !== 'owner' && caller?.role !== 'admin') {
          throw new ForbiddenException('Insufficient role');
        }
        callerRole = caller.role;
      }

      // The role is re-read under the lock, so a concurrent promotion cannot slip past these rules.
      if (mode === 'leave') {
        if (target.role === 'owner') {
          throw new ConflictException('The owner cannot leave the workspace');
        }
      } else {
        if (target.role === 'owner') {
          throw new ConflictException({
            code: 'cannot_remove_owner',
            message: 'cannot_remove_owner',
          });
        }
        if (userId === scope.userId) {
          throw new BadRequestException({ code: 'use_leave', message: 'use_leave' });
        }
        // Same reason as demotion: an admin who could remove another admin could remove the
        // accountability above them.
        if (target.role === 'admin' && callerRole !== 'owner') {
          throw new ForbiddenException('Only the owner can remove an admin');
        }
      }

      const removed = await this.projectMembers.removeAllInTx(tx, scope, userId);
      await tx
        .update(passwordResetLinks)
        .set({ usedAt: sql`now()`, ...updatedStamp(scope.actor) })
        .where(
          and(
            eq(passwordResetLinks.userId, userId),
            eq(passwordResetLinks.workspaceId, scope.workspaceId),
            isNull(passwordResetLinks.usedAt),
          ),
        );
      // R101: whoever leaves or is removed loses the links they made and needs approval to rejoin.
      await revokeLinks(tx, scope, eq(inviteLinks.createdBy, userId));
      await tx
        .insert(workspaceRemovals)
        .values(scopedInsert(scope, { userId }))
        .onConflictDoUpdate({
          target: [workspaceRemovals.workspaceId, workspaceRemovals.userId],
          set: updatedStamp(scope.actor),
        });
      // R110: a rejoin starts with no module grants, so an old grant cannot come back with the member.
      await tx
        .delete(memberPermissions)
        .where(
          and(
            eq(memberPermissions.workspaceId, scope.workspaceId),
            eq(memberPermissions.userId, userId),
          ),
        );
      await tx.delete(authSchema.member).where(eq(authSchema.member.id, target.id));
      await tx
        .update(authSchema.session)
        .set({ activeOrganizationId: null })
        .where(
          and(
            eq(authSchema.session.userId, userId),
            eq(authSchema.session.activeOrganizationId, scope.workspaceId),
          ),
        );
      return removed;
    });

    const handlers = Promise.all([
      this.revocation.memberRemoved(scope.workspaceId, userId),
      this.projectMembers.notifyRemoved(scope, projectIds, userId),
    ]);
    await this.endSessionsIfNoWorkspaceLeft(userId);
    await handlers;
    return projectIds;
  }

  private async transact<T>(run: Parameters<Db['transaction']>[0]): Promise<T> {
    try {
      return (await this.db.transaction(run)) as T;
    } catch (err) {
      if (hasPgCode(err, PG_DEADLOCK) || hasPgCode(err, PG_SERIALIZATION)) {
        throw new ConflictException({
          code: 'conflict',
          message: 'The workspace changed at the same moment. Try again.',
        });
      }
      throw err;
    }
  }

  // The member row is already gone, so access has ended through the guard. A failure here only
  // leaves sessions that can no longer reach any workspace, so it is logged and not surfaced.
  private async endSessionsIfNoWorkspaceLeft(userId: string): Promise<void> {
    try {
      const [remaining] = await this.db
        .select({ id: authSchema.member.id })
        .from(authSchema.member)
        .where(eq(authSchema.member.userId, userId))
        .limit(1);
      if (!remaining) {
        await (await this.auth.$context).internalAdapter.deleteUserSessions(userId);
      }
    } catch (err) {
      this.log.error(
        `Could not delete sessions of user ${userId} after removal: ${describeError(err)}`,
      );
    }
  }

  private async select(workspaceId: string, userId?: string): Promise<MemberSummary[]> {
    const rows = await this.db
      .select({
        userId: authSchema.member.userId,
        name: authSchema.user.name,
        email: authSchema.user.email,
        role: authSchema.member.role,
        joinedAt: authSchema.member.createdAt,
        emailVerified: authSchema.user.emailVerified,
      })
      .from(authSchema.member)
      .innerJoin(authSchema.user, eq(authSchema.member.userId, authSchema.user.id))
      .where(
        and(
          eq(authSchema.member.organizationId, workspaceId),
          userId ? eq(authSchema.member.userId, userId) : undefined,
        ),
      )
      .orderBy(asc(authSchema.member.createdAt), asc(authSchema.member.id));
    return rows.map((r) => ({
      userId: r.userId,
      name: r.name,
      email: r.email,
      role: Role.parse(r.role),
      joinedAt: r.joinedAt.toISOString(),
      emailVerified: r.emailVerified,
    }));
  }
}
