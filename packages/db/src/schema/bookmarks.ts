import { index, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { auditColumns } from '../audit.ts';
import { user } from './auth.ts';

export const workspaceBookmarks = pgTable(
  'workspace_bookmarks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    label: text('label').notNull(),
    remoteBaseUrl: text('remote_base_url').notNull(),
    remoteInstallId: text('remote_install_id').notNull(),
    remoteWorkspaceId: text('remote_workspace_id').notNull(),
    ...auditColumns(),
  },
  (t) => [
    index('workspace_bookmarks_user_id_idx').on(t.userId),
    uniqueIndex('workspace_bookmarks_remote_key').on(
      t.userId,
      t.remoteInstallId,
      t.remoteWorkspaceId,
    ),
  ],
);
