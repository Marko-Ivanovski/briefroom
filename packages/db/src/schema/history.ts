import { sql } from 'drizzle-orm';
import { index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { auditColumns, type Via } from '../audit.ts';
import { organization } from './auth.ts';
import { projects } from './projects.ts';

export interface FieldChange {
  from: unknown;
  to: unknown;
}

export type Changes = Record<string, FieldChange>;

/**
 * Append-only. `project_id` is the record's project when it was written, so visibility follows the
 * record: a null project means workspace-level content that every member sees.
 */
export const recordHistory = pgTable(
  'record_history',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id').references(() => projects.id, { onDelete: 'cascade' }),
    tableName: text('table_name').notNull(),
    recordId: uuid('record_id').notNull(),
    changes: jsonb('changes').$type<Changes>().notNull(),
    actorId: text('actor_id').notNull(),
    via: text('via').$type<Via>().notNull(),
    agent: text('agent'),
    // The clock, not the transaction start, so entries written in one transaction keep their order.
    at: timestamp('at', { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),
    ...auditColumns(),
  },
  (t) => [
    index('record_history_record_idx').on(t.workspaceId, t.tableName, t.recordId, t.at.desc()),
  ],
);
