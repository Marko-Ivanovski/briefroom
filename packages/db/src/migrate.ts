import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { fileURLToPath } from 'node:url';
import type { Db } from './client.ts';

const migrationsFolder = fileURLToPath(new URL('../migrations', import.meta.url));
const MIGRATION_LOCK = `hashtext('briefroom:migrations')`;

/** Only the app process migrates. The advisory lock is session-level, so it lives on one client. */
export async function runMigrations(db: Db): Promise<void> {
  const client = await db.$client.connect();
  try {
    await client.query(`SELECT pg_advisory_lock(${MIGRATION_LOCK})`);
    try {
      await migrate(drizzle({ client }), { migrationsFolder });
    } finally {
      await client.query(`SELECT pg_advisory_unlock(${MIGRATION_LOCK})`);
    }
  } finally {
    client.release();
  }
}
