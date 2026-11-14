import type { ChecklistKind, ProjectMemberSummary } from '@briefroom/contracts';
import {
  authSchema,
  projectAccessChecklist,
  projectMembers,
  projects,
  projectToolLinks,
  scoped,
  scopedInsert,
  scopedProjects,
  scopedUpdate,
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
import { RevocationService } from '../members/revocation.service.ts';

export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

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
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly revocation: RevocationService,
  ) {}

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
      const row = await this.db.transaction(async (tx) => {
        // Removal locks the member row FOR UPDATE before it reads project memberships, so this
        // shared lock makes a concurrent add wait, then see that the person is gone.
        const [stillMember] = await tx
          .select({ id: authSchema.member.id })
          .from(authSchema.member)
          .where(
            and(
              eq(authSchema.member.organizationId, scope.workspaceId),
              eq(authSchema.member.userId, userId),
            ),
          )
          .for('share');
        if (!stillMember) {
          throw new BadRequestException({
            code: 'not_a_workspace_member',
            message: 'not_a_workspace_member',
          });
        }
        await this.lockProject(tx, scope, projectId);
        const [added] = await tx
          .insert(projectMembers)
          .values(scopedInsert(scope, { projectId, userId }))
          .onConflictDoNothing()
          .returning({ addedAt: projectMembers.createdAt });
        if (added) await this.resetChecklist(tx, scope, projectId, userId, 'add');
        return added;
      });
      if (!row)
        throw new ConflictException({ code: 'already_on_project', message: 'already_on_project' });
      await this.revocation.projectMemberAdded(scope.workspaceId, userId);
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
        throw new NotFoundException({ code: 'project_not_found', message: 'Project not found' });
      }
      throw err;
    }
  }

  /**
   * The single place a project membership is deleted, so revocation hooks attach here. The
   * `remove` checklist is created in the same transaction, so nobody keeps repo access unnoticed.
   */
  async remove(scope: Scope, projectId: string, userId: string): Promise<void> {
    if (!z.uuid().safeParse(projectId).success) throw new NotFoundException('Project not found');
    await this.guardLinks(() =>
      this.db.transaction(async (tx) => {
        await this.lockProject(tx, scope, projectId);
        const deleted = await this.deleteMembership(tx, scope, projectId, userId);
        if (!deleted) throw new NotFoundException('Not on this project');
        await this.resetChecklist(tx, scope, projectId, userId, 'remove');
      }),
    );
    await this.revocation.projectMemberRemoved(scope.workspaceId, projectId, userId);
  }

  /**
   * Removes the person from every project they are on in this workspace inside the caller's
   * transaction, which must already hold the person's `member` row FOR UPDATE. Call
   * `notifyRemoved` after that transaction commits.
   */
  async removeAllInTx(tx: Tx, callerScope: Scope, userId: string): Promise<string[]> {
    // The guard's visible project list may be stale, so the person's projects are read here, under
    // the member lock, across the whole workspace.
    const scope: Scope = { ...callerScope, visibleProjectIds: 'all' };
    return this.guardLinks(async () => {
      const rows = await tx
        .select({ projectId: projectMembers.projectId })
        .from(projectMembers)
        .where(and(scoped(scope, projectMembers), eq(projectMembers.userId, userId)))
        .orderBy(asc(projectMembers.projectId));
      const ids: string[] = [];
      for (const { projectId } of rows) {
        try {
          await this.lockProject(tx, scope, projectId);
        } catch (err) {
          // Deleted concurrently: its membership row went with it.
          if (err instanceof NotFoundException) continue;
          throw err;
        }
        if (await this.deleteMembership(tx, scope, projectId, userId)) {
          await this.resetChecklist(tx, scope, projectId, userId, 'remove');
          ids.push(projectId);
        }
      }
      return ids;
    });
  }

  notifyRemoved(scope: Scope, projectIds: string[], userId: string): Promise<unknown> {
    return Promise.all(
      projectIds.map((id) => this.revocation.projectMemberRemoved(scope.workspaceId, id, userId)),
    );
  }

  private async deleteMembership(
    tx: Tx,
    scope: Scope,
    projectId: string,
    userId: string,
  ): Promise<boolean> {
    const deleted = await tx
      .delete(projectMembers)
      .where(
        and(
          scoped(scope, projectMembers),
          eq(projectMembers.projectId, projectId),
          eq(projectMembers.userId, userId),
        ),
      )
      .returning({ userId: projectMembers.userId });
    return deleted.length > 0;
  }

  // A concurrent project edit holds FOR UPDATE and may delete tool links. A shared lock makes this
  // transaction wait for it, so the links read below are the ones that still exist.
  private async lockProject(tx: Tx, scope: Scope, projectId: string): Promise<void> {
    const [project] = await tx
      .select({ id: projects.id })
      .from(projects)
      .where(and(scopedProjects(scope), eq(projects.id, projectId)))
      .for('share');
    if (!project) throw new NotFoundException('Project not found');
  }

  private async guardLinks<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (err) {
      if (hasPgCode(err, PG_FOREIGN_KEY_VIOLATION)) {
        throw new NotFoundException({ code: 'project_not_found', message: 'Project not found' });
      }
      throw err;
    }
  }

  // Each add is a new grant and each removal a new revocation, so the items start undone again (R80).
  private async resetChecklist(
    tx: Tx,
    scope: Scope,
    projectId: string,
    userId: string,
    kind: ChecklistKind,
  ): Promise<void> {
    const links = await tx
      .select({ id: projectToolLinks.id })
      .from(projectToolLinks)
      .where(and(scoped(scope, projectToolLinks), eq(projectToolLinks.projectId, projectId)));
    if (links.length === 0) return;
    await tx
      .insert(projectAccessChecklist)
      .values(links.map((l) => scopedInsert(scope, { projectId, userId, toolLinkId: l.id, kind })))
      .onConflictDoUpdate({
        target: [
          projectAccessChecklist.projectId,
          projectAccessChecklist.userId,
          projectAccessChecklist.toolLinkId,
          projectAccessChecklist.kind,
        ],
        set: scopedUpdate(scope, { done: false }),
      });
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
