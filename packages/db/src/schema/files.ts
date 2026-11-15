import { index, integer, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { auditColumns } from '../audit.ts';
import { organization } from './auth.ts';
import { projects } from './projects.ts';

/** Metadata for an image kept on disk. A null project is workspace-level, visible to every member. */
export const files = pgTable(
  'files',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id').references(() => projects.id, { onDelete: 'cascade' }),
    moduleId: text('module_id').notNull(),
    mime: text('mime').notNull(),
    bytes: integer('bytes').notNull(),
    sha256: text('sha256').notNull(),
    width: integer('width').notNull(),
    height: integer('height').notNull(),
    ...auditColumns(),
  },
  (t) => [index('files_workspace_project_idx').on(t.workspaceId, t.projectId)],
);

export type FileRow = typeof files.$inferSelect;
