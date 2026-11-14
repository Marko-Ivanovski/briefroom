import { index, pgTable, primaryKey, text, uuid } from 'drizzle-orm/pg-core';
import { auditColumns } from '../audit.ts';
import { organization, user } from './auth.ts';
import { projects } from './projects.ts';

export const projectMembers = pgTable(
  'project_members',
  {
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    ...auditColumns(),
  },
  (t) => [
    primaryKey({ columns: [t.projectId, t.userId] }),
    index('project_members_workspace_user_idx').on(t.workspaceId, t.userId),
  ],
);
