import { is } from 'drizzle-orm';
import { PgTable } from 'drizzle-orm/pg-core';
import * as schema from './schema/index.ts';

export const BETTER_AUTH_TABLES: readonly string[] = [
  'user',
  'session',
  'account',
  'verification',
  'organization',
  'member',
  'invitation',
  'apikey',
];

export function allTables(): PgTable[] {
  return Object.values(schema).filter((v): v is PgTable => is(v, PgTable));
}
