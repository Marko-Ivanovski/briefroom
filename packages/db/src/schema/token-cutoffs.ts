import { pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { auditColumns } from '../audit.ts';
import { user } from './auth.ts';

// Account-level, not workspace content. A token created at or before valid_after is refused, so a
// password reset ends every older token even if deleting the key rows fails.
export const tokenCutoffs = pgTable('token_cutoffs', {
  userId: text('user_id')
    .primaryKey()
    .references(() => user.id, { onDelete: 'cascade' }),
  validAfter: timestamp('valid_after', { withTimezone: true }).notNull(),
  ...auditColumns(),
});
