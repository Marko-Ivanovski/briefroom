import { pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { auditColumns } from '../audit.ts';
import { organization, user } from './auth.ts';

// One row per person who was removed from or left a workspace. Joining again then needs approval,
// and approving the request deletes the row.
export const workspaceRemovals = pgTable(
  'workspace_removals',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    ...auditColumns(),
  },
  (t) => [uniqueIndex('workspace_removals_workspace_user_key').on(t.workspaceId, t.userId)],
);
