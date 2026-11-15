import { index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { auditColumns } from '../audit.ts';
import { organization } from './auth.ts';
import { projects } from './projects.ts';

/**
 * One row per MCP tool call. It stores the tool name and ids only: never arguments, prompts or
 * results. `agent` is the normalised X-Briefroom-Agent value.
 */
export const usageEvents = pgTable(
  'usage_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id').references(() => projects.id, { onDelete: 'set null' }),
    userId: text('user_id').notNull(),
    agent: text('agent').notNull(),
    tool: text('tool').notNull(),
    itemType: text('item_type'),
    itemId: text('item_id'),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
    ...auditColumns(),
  },
  (t) => [index('usage_events_workspace_at_idx').on(t.workspaceId, t.at.desc())],
);
