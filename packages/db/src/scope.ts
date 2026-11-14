import { and, eq, getTableColumns, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';
import {
  createdStamp,
  updatedStamp,
  type Actor,
  type CreatedStamp,
  type UpdatedStamp,
} from './audit.ts';
import type { AnyPgColumn, PgColumn, PgTable } from 'drizzle-orm/pg-core';
import { projects } from './schema/projects.ts';

export interface ScopeFilter {
  workspaceId: string;
  visibleProjectIds: 'all' | readonly string[];
}

/** A table with a `workspaceId` column. A `projectId` column, when present, is scoped too. */
export type ScopedTable = PgTable & { workspaceId: AnyPgColumn; projectId?: AnyPgColumn };

function columnNamed(table: ScopedTable, name: string): PgColumn | undefined {
  return Object.values<PgColumn>(getTableColumns(table)).find((c) => c.name === name);
}

/**
 * The only way services build the `where` for a scoped table. The projects table has no
 * `project_id` (its own `id` is the project), so this checks only the workspace for it: use
 * `scopedProjects()` there.
 */
export function scoped(filter: ScopeFilter, table: ScopedTable): SQL {
  const workspace = columnNamed(table, 'workspace_id');
  if (!workspace) throw new Error('scoped() needs a table with a workspace_id column');
  const inWorkspace = eq(workspace, filter.workspaceId);

  const project = columnNamed(table, 'project_id');
  if (!project || filter.visibleProjectIds === 'all') return inWorkspace;
  // A nullable project_id marks workspace-wide content, which every member sees.
  const visible =
    filter.visibleProjectIds.length > 0 ? [inArray(project, [...filter.visibleProjectIds])] : [];
  const projectRule = project.notNull ? visible[0] : or(isNull(project), ...visible);
  return and(inWorkspace, projectRule ?? sql`false`)!;
}

/**
 * The `where` for the projects table: the workspace, plus `id IN visibleProjectIds` unless the
 * caller sees 'all'. A separate function rather than an option on scoped(), so the table that
 * needs it cannot be passed to the wrong one without a type error here.
 */
export function scopedProjects(filter: ScopeFilter): SQL {
  const inWorkspace = eq(projects.workspaceId, filter.workspaceId);
  if (filter.visibleProjectIds === 'all') return inWorkspace;
  if (filter.visibleProjectIds.length === 0) return and(inWorkspace, sql`false`)!;
  return and(inWorkspace, inArray(projects.id, [...filter.visibleProjectIds]))!;
}

export interface WriteScope {
  workspaceId: string;
  actor: Actor;
}

const CREATION_AUDIT_KEYS = ['createdBy', 'createdAt', 'createdVia', 'createdAgent'] as const;

type Immutable = { workspaceId?: never } & { [K in (typeof CREATION_AUDIT_KEYS)[number]]?: never };

/** The only way services build values for an insert into a scoped table. */
export function scopedInsert<V extends object>(
  scope: WriteScope,
  values: V,
): Omit<V, 'workspaceId' | keyof CreatedStamp> & { workspaceId: string } & CreatedStamp {
  return { ...values, workspaceId: scope.workspaceId, ...createdStamp(scope.actor) };
}

/** The only way services build values for an update of a scoped table. A row keeps its workspace and its creation audit. */
export function scopedUpdate<V extends object & Immutable>(
  scope: WriteScope,
  values: V,
): V & UpdatedStamp {
  for (const key of ['workspaceId', ...CREATION_AUDIT_KEYS]) {
    if (key in values) throw new Error(`scopedUpdate cannot change ${key}`);
  }
  return { ...values, ...updatedStamp(scope.actor) };
}
