import type { ChecklistItem, ChecklistKind } from '@briefroom/contracts';
import {
  authSchema,
  projectAccessChecklist,
  projects,
  projectToolLinks,
  scoped,
  scopedInsert,
  scopedProjects,
  scopedUpdate,
  type Db,
} from '@briefroom/db';
import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { canViewProject, type Scope } from '../access/scope.ts';
import { DB } from '../database/database.module.ts';

const PG_UNIQUE_VIOLATION = '23505';
const PG_FOREIGN_KEY_VIOLATION = '23503';

function hasPgCode(err: unknown, code: string): boolean {
  for (let e = err, depth = 0; e && typeof e === 'object' && depth < 5; depth++) {
    if ((e as { code?: unknown }).code === code) return true;
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}

@Injectable()
export class ChecklistService {
  constructor(@Inject(DB) private readonly db: Db) {}

  async list(
    scope: Scope,
    projectId: string,
    userId: string,
    kind: ChecklistKind,
  ): Promise<ChecklistItem[]> {
    await this.requireEligible(scope, projectId, userId);
    const links = await this.toolLinks(scope, projectId);
    if (links.length > 0) {
      await this.guard(() =>
        this.db
          .insert(projectAccessChecklist)
          .values(
            links.map((l) => scopedInsert(scope, { projectId, userId, toolLinkId: l.id, kind })),
          )
          .onConflictDoNothing(),
      );
    }
    return this.items(scope, projectId, userId, kind);
  }

  async set(
    scope: Scope,
    projectId: string,
    userId: string,
    input: { toolLinkId: string; kind: ChecklistKind; done: boolean },
  ): Promise<ChecklistItem> {
    await this.requireEligible(scope, projectId, userId);
    const links = await this.toolLinks(scope, projectId);
    if (!links.some((l) => l.id === input.toolLinkId)) {
      throw new NotFoundException('Tool link not found');
    }
    const key = and(
      scoped(scope, projectAccessChecklist),
      eq(projectAccessChecklist.projectId, projectId),
      eq(projectAccessChecklist.userId, userId),
      eq(projectAccessChecklist.toolLinkId, input.toolLinkId),
      eq(projectAccessChecklist.kind, input.kind),
    );
    await this.guard(async () => {
      await this.db
        .insert(projectAccessChecklist)
        .values(
          scopedInsert(scope, {
            projectId,
            userId,
            toolLinkId: input.toolLinkId,
            kind: input.kind,
          }),
        )
        .onConflictDoNothing();
      await this.db
        .update(projectAccessChecklist)
        .set(scopedUpdate(scope, { done: input.done }))
        .where(key);
    });
    const [item] = await this.items(scope, projectId, userId, input.kind, input.toolLinkId);
    if (!item) throw new NotFoundException('Tool link not found');
    return item;
  }

  private async items(
    scope: Scope,
    projectId: string,
    userId: string,
    kind: ChecklistKind,
    toolLinkId?: string,
  ): Promise<ChecklistItem[]> {
    const rows = await this.db
      .select({
        toolLinkId: projectToolLinks.id,
        label: projectToolLinks.label,
        url: projectToolLinks.url,
        done: projectAccessChecklist.done,
        doneBy: authSchema.user.name,
        doneAt: projectAccessChecklist.updatedAt,
      })
      .from(projectToolLinks)
      .innerJoin(
        projectAccessChecklist,
        and(
          eq(projectAccessChecklist.toolLinkId, projectToolLinks.id),
          scoped(scope, projectAccessChecklist),
          eq(projectAccessChecklist.projectId, projectId),
          eq(projectAccessChecklist.userId, userId),
          eq(projectAccessChecklist.kind, kind),
        ),
      )
      .leftJoin(authSchema.user, eq(authSchema.user.id, projectAccessChecklist.updatedBy))
      .where(
        and(
          scoped(scope, projectToolLinks),
          eq(projectToolLinks.projectId, projectId),
          toolLinkId ? eq(projectToolLinks.id, toolLinkId) : undefined,
        ),
      )
      .orderBy(asc(projectToolLinks.createdAt), asc(projectToolLinks.id));
    return rows.map((row) => ({
      toolLinkId: row.toolLinkId,
      label: row.label,
      url: row.url,
      done: row.done,
      doneBy: row.done ? row.doneBy : null,
      doneAt: row.done ? row.doneAt.toISOString() : null,
    }));
  }

  private toolLinks(scope: Scope, projectId: string): Promise<{ id: string }[]> {
    return this.db
      .select({ id: projectToolLinks.id })
      .from(projectToolLinks)
      .where(and(scoped(scope, projectToolLinks), eq(projectToolLinks.projectId, projectId)))
      .orderBy(asc(projectToolLinks.createdAt), asc(projectToolLinks.id));
  }

  /**
   * A checklist exists for a current workspace member, or for anyone who already has rows on
   * this project, so the `remove` list stays reachable after they leave the project or workspace.
   */
  private async requireEligible(scope: Scope, projectId: string, userId: string): Promise<void> {
    if (!z.uuid().safeParse(projectId).success || !canViewProject(scope, projectId)) {
      throw new NotFoundException('Project not found');
    }
    const [project] = await this.db
      .select({ id: projects.id })
      .from(projects)
      .where(and(scopedProjects(scope), eq(projects.id, projectId)));
    if (!project) throw new NotFoundException('Project not found');

    const [member] = await this.db
      .select({ userId: authSchema.member.userId })
      .from(authSchema.member)
      .where(
        and(
          eq(authSchema.member.organizationId, scope.workspaceId),
          eq(authSchema.member.userId, userId),
        ),
      );
    if (member) return;
    const [existing] = await this.db
      .select({ id: projectAccessChecklist.id })
      .from(projectAccessChecklist)
      .where(
        and(
          scoped(scope, projectAccessChecklist),
          eq(projectAccessChecklist.projectId, projectId),
          eq(projectAccessChecklist.userId, userId),
        ),
      )
      .limit(1);
    if (!existing) throw new NotFoundException('User not found');
  }

  private async guard(run: () => PromiseLike<unknown>): Promise<void> {
    try {
      await run();
    } catch (err) {
      if (hasPgCode(err, PG_UNIQUE_VIOLATION)) throw new ConflictException('checklist_conflict');
      if (hasPgCode(err, PG_FOREIGN_KEY_VIOLATION)) {
        throw new NotFoundException('Tool link not found');
      }
      throw err;
    }
  }
}
