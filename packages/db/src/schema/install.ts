import { sql } from 'drizzle-orm';
import { boolean, check, integer, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { auditColumns } from '../audit.ts';
import { user } from './auth.ts';

// One row per install. `singleton` plus its unique and check constraints make a second row impossible.
export const install = pgTable(
  'install',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    singleton: boolean('singleton').notNull().default(true).unique('install_singleton_key'),
    ownerUserId: text('owner_user_id').references(() => user.id, { onDelete: 'restrict' }),
    setupCodeHash: text('setup_code_hash'),
    failedSetupAttempts: integer('failed_setup_attempts').notNull().default(0),
    ...auditColumns(),
  },
  (t) => [check('install_singleton_true', sql`${t.singleton}`)],
);
