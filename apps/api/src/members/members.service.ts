import { Role, type MemberSummary } from '@briefroom/contracts';
import { authSchema, passwordResetLinks, updatedStamp, type Db } from '@briefroom/db';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, asc, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import type { Scope } from '../access/scope.ts';
import { AUTH } from '../auth/auth.module.ts';
import type { Auth } from '../auth/auth.ts';
import { DB } from '../database/database.module.ts';
import { ProjectMembersService } from '../projects/project-members.service.ts';
import { RevocationService } from './revocation.service.ts';

@Injectable()
export class MembersService {
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

  async leave(scope: Scope, headers: Headers): Promise<void> {
    if (scope.role === 'owner') throw new ConflictException('The owner cannot leave the workspace');
    await this.revoke(scope, scope.userId, () =>
      this.auth.api
        .leaveOrganization({ headers, body: { organizationId: scope.workspaceId } })
        .then(() => undefined),
    );
  }

  async remove(scope: Scope, headers: Headers, targetUserId: string): Promise<void> {
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
    if (target.role === 'owner') {
      throw new ConflictException({ code: 'cannot_remove_owner', message: 'cannot_remove_owner' });
    }
    if (targetUserId === scope.userId) {
      throw new BadRequestException({ code: 'use_leave', message: 'use_leave' });
    }
    // Same reason as demotion: an admin who could remove another admin could remove the
    // accountability above them.
    if (target.role === 'admin' && scope.role !== 'owner') {
      throw new ForbiddenException('Only the owner can remove an admin');
    }
    await this.revoke(scope, targetUserId, () =>
      this.auth.api
        .removeMember({
          headers,
          body: { memberIdOrEmail: target.id, organizationId: scope.workspaceId },
        })
        .then(() => undefined),
    );
  }

  /**
   * Shared by removal and leaving. Project memberships, their `remove` checklists and the reset
   * links go in one transaction that stays open while Better Auth deletes the member row, so a
   * failure there rolls the project cleanup back and nobody is left half-removed. Past records are
   * untouched: `created_by` and `updated_by` are never rewritten.
   */
  private async revoke(
    scope: Scope,
    userId: string,
    deleteMember: () => Promise<void>,
  ): Promise<void> {
    await this.projectMembers.removeFromWorkspace(scope, userId, async (tx) => {
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
      await deleteMember();
    });
    await this.revocation.memberRemoved(scope.workspaceId, userId);

    const [remaining] = await this.db
      .select({ id: authSchema.member.id })
      .from(authSchema.member)
      .where(eq(authSchema.member.userId, userId))
      .limit(1);
    if (!remaining) {
      await (await this.auth.$context).internalAdapter.deleteUserSessions(userId);
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
