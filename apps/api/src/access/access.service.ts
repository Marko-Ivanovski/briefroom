import { Role } from '@briefroom/contracts';
import { authSchema, projectMembers, type Db, type Via } from '@briefroom/db';
import { Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { DB } from '../database/database.module.ts';
import type { Scope } from './scope.ts';

@Injectable()
export class AccessService {
  constructor(@Inject(DB) private readonly db: Db) {}

  /** Returns null for a non-member, so callers can answer 404 without leaking that the workspace exists. */
  async scopeFor(
    userId: string,
    workspaceId: string,
    via: Via,
    agent?: string,
  ): Promise<Scope | null> {
    const [row] = await this.db
      .select({ role: authSchema.member.role })
      .from(authSchema.member)
      .where(
        and(
          eq(authSchema.member.userId, userId),
          eq(authSchema.member.organizationId, workspaceId),
        ),
      );
    const role = Role.safeParse(row?.role);
    if (!role.success) return null;

    return {
      userId,
      workspaceId,
      role: role.data,
      visibleProjectIds:
        role.data === 'member' ? await this.projectIdsOf(userId, workspaceId) : 'all',
      permissions: new Set(),
      actor: { userId, via, ...(agent ? { agent } : {}) },
    };
  }

  private async projectIdsOf(userId: string, workspaceId: string): Promise<string[]> {
    const rows = await this.db
      .select({ projectId: projectMembers.projectId })
      .from(projectMembers)
      .where(and(eq(projectMembers.workspaceId, workspaceId), eq(projectMembers.userId, userId)));
    return rows.map((r) => r.projectId);
  }
}
