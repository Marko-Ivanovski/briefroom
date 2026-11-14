import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { auditColumns } from '../audit.ts';
import { organization } from './auth.ts';

export const INVITE_ROLES = ['admin', 'member'] as const;
export type InviteRole = (typeof INVITE_ROLES)[number];

export const inviteLinks = pgTable(
  'invite_links',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull().unique('invite_links_token_hash_key'),
    role: text('role').$type<InviteRole>().notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    maxUses: integer('max_uses'),
    uses: integer('uses').notNull().default(0),
    requiresApproval: boolean('requires_approval').notNull().default(false),
    projectIds: uuid('project_ids')
      .array()
      .notNull()
      .default(sql`'{}'::uuid[]`),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    ...auditColumns(),
  },
  (t) => [
    index('invite_links_workspace_id_idx').on(t.workspaceId),
    check('invite_links_admin_needs_approval', sql`${t.role} <> 'admin' or ${t.requiresApproval}`),
    check('invite_links_role_valid', sql`${t.role} in ('admin', 'member')`),
    check('invite_links_max_uses_positive', sql`${t.maxUses} is null or ${t.maxUses} > 0`),
  ],
);
