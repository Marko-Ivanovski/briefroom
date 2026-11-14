import { index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { auditColumns } from '../audit.ts';
import { organization, user } from './auth.ts';

// workspace_id is null for links the host command issues, which belong to the install, not a workspace.
export const passwordResetLinks = pgTable(
  'password_reset_links',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: text('workspace_id').references(() => organization.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull().unique('password_reset_links_token_hash_key'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    ...auditColumns(),
  },
  (t) => [index('password_reset_links_user_id_idx').on(t.userId)],
);
