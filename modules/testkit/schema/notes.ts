import { auditColumns, authSchema, projects } from '@briefroom/db';
import { index, pgTable, text, uuid } from 'drizzle-orm/pg-core';

/** Kept in step by hand with `testkit.sql`: this table never enters the main migration history. */
export const testkitNotes = pgTable(
  'testkit_notes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => authSchema.organization.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id').references(() => projects.id, { onDelete: 'cascade' }),
    text: text('text').notNull(),
    ...auditColumns(),
  },
  (t) => [index('testkit_notes_workspace_id_idx').on(t.workspaceId)],
);
