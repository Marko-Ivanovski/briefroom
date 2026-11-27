import { sql } from 'drizzle-orm';
import { boolean, check, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { auditColumns } from '../audit.ts';

export const REMOTE_ACCESS_MODES = ['off', 'tailscale', 'funnel', 'cloudflare'] as const;
export type RemoteAccessModeValue = (typeof REMOTE_ACCESS_MODES)[number];

export const REMOTE_ACCESS_STATUSES = [
  'off',
  'starting',
  'running',
  'restarting',
  'error',
] as const;
export type RemoteAccessStatusValue = (typeof REMOTE_ACCESS_STATUSES)[number];

// One install-level row. The tunnel credential is only ever stored sealed (AES-256-GCM).
export const remoteAccess = pgTable(
  'remote_access',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    singleton: boolean('singleton').notNull().default(true).unique('remote_access_singleton_key'),
    mode: text('mode').$type<RemoteAccessModeValue>().notNull().default('off'),
    secretCiphertext: text('secret_ciphertext'),
    publicUrl: text('public_url'),
    status: text('status').$type<RemoteAccessStatusValue>().notNull().default('off'),
    lastError: text('last_error'),
    ...auditColumns(),
  },
  (t) => [
    check('remote_access_singleton_true', sql`${t.singleton}`),
    check(
      'remote_access_mode_known',
      sql`${t.mode} in ('off', 'tailscale', 'funnel', 'cloudflare')`,
    ),
    check(
      'remote_access_status_known',
      sql`${t.status} in ('off', 'starting', 'running', 'restarting', 'error')`,
    ),
  ],
);
