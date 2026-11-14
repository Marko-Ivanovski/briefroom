import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { createDb, type Db } from './client.ts';
import { runMigrations } from './migrate.ts';

const DEV_URL = 'postgres://briefroom:briefroom@127.0.0.1:54329/briefroom_dev';

export interface TestDb {
  db: Db;
  url: string;
  reset(): Promise<void>;
  close(): Promise<void>;
}

async function withAdmin<T>(url: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

export async function createTestDb(): Promise<TestDb> {
  const adminUrl = process.env.DATABASE_URL ?? DEV_URL;
  const name = `briefroom_test_${randomBytes(6).toString('hex')}`;
  const testUrl = new URL(adminUrl);
  testUrl.pathname = `/${name}`;
  const url = testUrl.toString();
  const drop = () =>
    withAdmin(adminUrl, (c) => c.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`));

  await withAdmin(adminUrl, (c) => c.query(`CREATE DATABASE "${name}"`));
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
