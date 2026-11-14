import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { DEV_DATABASE_URL } from './dev-url.ts';
import { createDb, type Db } from './client.ts';
import { runMigrations } from './migrate.ts';

export interface TestDb {
  db: Db;
  url: string;
  reset(): Promise<void>;
  close(): Promise<void>;
}

export async function createTestDb(): Promise<TestDb> {
  const adminUrl = process.env.DATABASE_URL ?? DEV_DATABASE_URL;
  const name = `briefroom_test_${randomBytes(6).toString('hex')}`;
  const testUrl = new URL(adminUrl);
  testUrl.pathname = `/${name}`;
  const url = testUrl.toString();
  // One admin connection serves both the CREATE and the DROP. On Windows, Node 24 intermittently
  // dies silently (exit 3221226505) when a short-lived admin connection runs CREATE/DROP DATABASE
  // and ends straight after.
  const admin = new pg.Client({ connectionString: adminUrl });
  admin.on('error', (err) => {
    console.error('Postgres admin connection error', err);
  });
  await admin.connect();
  let dropped = false;
  const drop = async () => {
    if (dropped) return;
    dropped = true;
    try {
      await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    } finally {
      await admin.end();
    }
  };

  try {
    await admin.query(`CREATE DATABASE "${name}"`);
  } catch (err) {
    await admin.end().catch(() => {});
    throw err;
  }
  const db = createDb(url);
  try {
    await runMigrations(db);
  } catch (err) {
    await db.$client.end();
    await drop();
    throw err;
  }

  return {
    db,
    url,
    async reset() {
      const { rows } = await db.$client.query<{ tablename: string }>(
        `SELECT tablename FROM pg_tables WHERE schemaname = 'public'`,
      );
      if (rows.length === 0) return;
      const list = rows.map((r) => `"public"."${r.tablename}"`).join(', ');
      await db.$client.query(`TRUNCATE ${list} RESTART IDENTITY CASCADE`);
    },
    async close() {
      if (dropped) return;
      await db.$client.end();
      await drop();
    },
  };
}

const STALE_AFTER_HOURS = 1;

/**
 * Drops test databases left behind by crashed workers. Only exact `briefroom_test_<12 hex>` names.
 * Ageing reads the data directory through pg_stat_file, which needs superuser. Without it, or
 * without a reachable server, the sweep warns once and skips.
 */
export async function sweepStaleTestDbs(): Promise<number> {
  const adminUrl = process.env.DATABASE_URL ?? DEV_DATABASE_URL;
  const client = new pg.Client({ connectionString: adminUrl });
  client.on('error', () => {});
  let stale: string[];
  try {
    await client.connect();
    const { rows } = await client.query<{ datname: string }>(
      `SELECT datname FROM pg_database
       WHERE datname ~ '^briefroom_test_[0-9a-f]{12}$'
         AND (pg_stat_file('base/' || oid || '/PG_VERSION', true)).modification
             < now() - make_interval(hours => $1)`,
      [STALE_AFTER_HOURS],
    );
    stale = rows.map((r) => r.datname);
  } catch (err) {
    console.warn(
      'Skipping the stale test database sweep:',
      err instanceof Error ? err.message : err,
    );
    await client.end().catch(() => {});
    return 0;
  }

  let dropped = 0;
  for (const name of stale) {
    try {
      await client.query(`DROP DATABASE IF EXISTS "${name}"`);
      dropped++;
    } catch {
      // In use, or already dropped by a concurrent sweep.
    }
  }
  await client.end().catch(() => {});
  return dropped;
}
