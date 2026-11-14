import { Role, type MemberSummary } from '@briefroom/contracts';
import { authSchema, passwordResetLinks, updatedStamp, type Db } from '@briefroom/db';
import {
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

@Injectable()
export class MembersService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(AUTH) private readonly auth: Auth,
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
    await this.auth.api.leaveOrganization({
      headers,
      body: { organizationId: scope.workspaceId },
    });
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
