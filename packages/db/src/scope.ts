import { and, eq, getTableColumns, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';
import {
  createdStamp,
  updatedStamp,
  type Actor,
  type CreatedStamp,
  type UpdatedStamp,
} from './audit.ts';
import type { AnyPgColumn, PgColumn, PgTable } from 'drizzle-orm/pg-core';

export interface ScopeFilter {
  workspaceId: string;
  visibleProjectIds: 'all' | readonly string[];
}

/** A table with a `workspaceId` column. A `projectId` column, when present, is scoped too. */
export type ScopedTable = PgTable & { workspaceId: AnyPgColumn; projectId?: AnyPgColumn };

function columnNamed(table: ScopedTable, name: string): PgColumn | undefined {
  return Object.values<PgColumn>(getTableColumns(table)).find((c) => c.name === name);
}

/** The only way services build the `where` for a scoped table. */
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
