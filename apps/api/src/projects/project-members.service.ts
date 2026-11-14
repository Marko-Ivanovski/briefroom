import type { ProjectMemberSummary } from '@briefroom/contracts';
import {
  authSchema,
  projectMembers,
  projects,
  scoped,
  scopedInsert,
  scopedProjects,
  type Db,
} from '@briefroom/db';
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { canViewProject, type Scope } from '../access/scope.ts';
import { DB } from '../database/database.module.ts';

const PG_UNIQUE_VIOLATION = '23505';
const PG_FOREIGN_KEY_VIOLATION = '23503';

// Drizzle wraps the driver error, so the pg code can sit on a nested `cause`.
function hasPgCode(err: unknown, code: string): boolean {
  for (let e = err, depth = 0; e && typeof e === 'object' && depth < 5; depth++) {
    if ((e as { code?: unknown }).code === code) return true;
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}

@Injectable()
export class ProjectMembersService {
  constructor(@Inject(DB) private readonly db: Db) {}

  async list(scope: Scope, projectId: string): Promise<ProjectMemberSummary[]> {
    await this.requireVisible(scope, projectId);
    const rows = await this.db
      .select({
        userId: authSchema.user.id,
        name: authSchema.user.name,
        email: authSchema.user.email,
        addedAt: projectMembers.createdAt,
      })
      .from(projectMembers)
      .innerJoin(authSchema.user, eq(authSchema.user.id, projectMembers.userId))
      .where(and(scoped(scope, projectMembers), eq(projectMembers.projectId, projectId)))
      .orderBy(asc(projectMembers.createdAt), asc(authSchema.user.id));
    return rows.map((r) => ({ ...r, addedAt: r.addedAt.toISOString() }));
  }

  async add(scope: Scope, projectId: string, userId: string): Promise<ProjectMemberSummary> {
    await this.requireVisible(scope, projectId);
    const [target] = await this.db
      .select({ id: authSchema.user.id, name: authSchema.user.name, email: authSchema.user.email })
      .from(authSchema.member)
      .innerJoin(authSchema.user, eq(authSchema.user.id, authSchema.member.userId))
      .where(
        and(
          eq(authSchema.member.organizationId, scope.workspaceId),
          eq(authSchema.member.userId, userId),
        ),
      );
    if (!target)
      throw new BadRequestException({
        code: 'not_a_workspace_member',
        message: 'not_a_workspace_member',
      });

    try {
      const [row] = await this.db
        .insert(projectMembers)
        .values(scopedInsert(scope, { projectId, userId }))
        .onConflictDoNothing()
        .returning({ addedAt: projectMembers.createdAt });
      if (!row)
        throw new ConflictException({ code: 'already_on_project', message: 'already_on_project' });
      return {
        userId: target.id,
        name: target.name,
        email: target.email,
        addedAt: row.addedAt.toISOString(),
      };
    } catch (err) {
      if (hasPgCode(err, PG_UNIQUE_VIOLATION))
        throw new ConflictException({ code: 'already_on_project', message: 'already_on_project' });
      if (hasPgCode(err, PG_FOREIGN_KEY_VIOLATION)) {
        throw new NotFoundException('Project not found');
      }
      throw err;
    }
  }

  /** The single place a project membership is deleted, so revocation hooks can attach here. */
  async remove(scope: Scope, projectId: string, userId: string): Promise<void> {
    if (!z.uuid().safeParse(projectId).success) throw new NotFoundException('Project not found');
    const deleted = await this.db
      .delete(projectMembers)
      .where(
        and(
          scoped(scope, projectMembers),
          eq(projectMembers.projectId, projectId),
          eq(projectMembers.userId, userId),
        ),
      )
      .returning({ userId: projectMembers.userId });
    if (deleted.length === 0) throw new NotFoundException('Not on this project');
  }

  leave(scope: Scope, projectId: string): Promise<void> {
    return this.remove(scope, projectId, scope.userId);
  }

  private async requireVisible(scope: Scope, projectId: string): Promise<void> {
    if (!z.uuid().safeParse(projectId).success || !canViewProject(scope, projectId)) {
      throw new NotFoundException('Project not found');
    }
    const [project] = await this.db
      .select({ id: projects.id })
      .from(projects)
      .where(and(scopedProjects(scope), eq(projects.id, projectId)));
    if (!project) throw new NotFoundException('Project not found');
  }
}
