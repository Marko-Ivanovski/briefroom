import { pgTable, primaryKey, text } from 'drizzle-orm/pg-core';
import { auditColumns } from '../audit.ts';
import { organization, user } from './auth.ts';

// A row's presence is the grant. Owners and admins hold every permission without rows.
export const memberPermissions = pgTable(
  'member_permissions',
  {
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    moduleId: text('module_id').notNull(),
    key: text('key').notNull(),
    ...auditColumns(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.userId, t.moduleId, t.key] })],
);
