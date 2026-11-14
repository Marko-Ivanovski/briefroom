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
  const drop = async () => {
    try {
      await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    } finally {
      await admin.end();
    }
  };

  try {
    await admin.query(`CREATE DATABASE "${name}"`);
  } catch (err) {
    await admin.end();
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
      await db.$client.end();
      await drop();
    },
  };
}
