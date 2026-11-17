import { index, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { auditColumns } from '../audit.ts';
import { organization, user } from './auth.ts';

export const CLI_LOGIN_STATUSES = ['pending', 'approved', 'consumed', 'denied'] as const;
export type CliLoginStatus = (typeof CLI_LOGIN_STATUSES)[number];

// Install-level, short-lived handshake for `briefroom login`. user_id and workspace_id stay null until
// approval. No token is ever stored here: the poll mints it, so only its id (token_id) is recorded.
export const cliLogins = pgTable(
  'cli_logins',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    code: text('code').notNull(),
    pollTokenHash: text('poll_token_hash').notNull(),
    deviceName: text('device_name').notNull(),
    status: text('status').$type<CliLoginStatus>().notNull().default('pending'),
    userId: text('user_id').references(() => user.id, { onDelete: 'cascade' }),
    workspaceId: text('workspace_id').references(() => organization.id, { onDelete: 'cascade' }),
    tokenId: text('token_id'),
    startIp: text('start_ip'),
    startUserAgent: text('start_user_agent'),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    approvedSessionId: text('approved_session_id'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    ...auditColumns(),
  },
  (t) => [
    unique('cli_logins_code_key').on(t.code),
    unique('cli_logins_poll_token_hash_key').on(t.pollTokenHash),
    index('cli_logins_expires_at_idx').on(t.expiresAt),
  ],
);
