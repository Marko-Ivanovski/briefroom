import { and, eq, getTableColumns, inArray, sql, type SQL } from 'drizzle-orm';
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
  if (filter.visibleProjectIds.length === 0) return sql`false`;
  return and(inWorkspace, inArray(project, [...filter.visibleProjectIds]))!;
}
