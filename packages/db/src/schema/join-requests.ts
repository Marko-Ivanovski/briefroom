import { sql } from 'drizzle-orm';
import { check, index, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { auditColumns } from '../audit.ts';
import { organization, user } from './auth.ts';
import { inviteLinks, type InviteRole } from './invites.ts';

export const JOIN_REQUEST_STATUSES = ['pending', 'approved', 'declined'] as const;
export type JoinRequestStatus = (typeof JOIN_REQUEST_STATUSES)[number];

export const joinRequests = pgTable(
  'join_requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    inviteId: uuid('invite_id').references(() => inviteLinks.id, { onDelete: 'set null' }),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    role: text('role').$type<InviteRole>().notNull(),
    projectIds: uuid('project_ids')
      .array()
      .notNull()
      .default(sql`'{}'::uuid[]`),
    status: text('status').$type<JoinRequestStatus>().notNull().default('pending'),
    ...auditColumns(),
  },
  (t) => [
    index('join_requests_workspace_id_idx').on(t.workspaceId),
    uniqueIndex('join_requests_one_pending_per_user')
      .on(t.workspaceId, t.userId)
      .where(sql`${t.status} = 'pending'`),
    check('join_requests_role_valid', sql`${t.role} in ('admin', 'member')`),
    check('join_requests_status_valid', sql`${t.status} in ('pending', 'approved', 'declined')`),
  ],
);
