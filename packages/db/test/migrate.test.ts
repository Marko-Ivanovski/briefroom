import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../src/client.ts';
import { DEV_DATABASE_URL } from '../src/dev-url.ts';
import { runMigrations } from '../src/migrate.ts';

const adminUrl = process.env.DATABASE_URL || DEV_DATABASE_URL;
const name = `briefroom_test_${randomBytes(6).toString('hex')}`;

async function admin(sql: string): Promise<void> {
  const client = new pg.Client({ connectionString: adminUrl });
  await client.connect();
  try {
    await client.query(sql);
  } finally {
    await client.end();
  }
}

describe('runMigrations', () => {
  let db: Db;

  beforeAll(async () => {
    await admin(`CREATE DATABASE "${name}"`);
    const url = new URL(adminUrl);
    url.pathname = `/${name}`;
    db = createDb(url.toString());
  });

  afterAll(async () => {
    await db.$client.end();
    await admin(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  });

  it('survives two concurrent runs and applies each migration once', async () => {
    await Promise.all([runMigrations(db), runMigrations(db)]);
    const { rows } = await db.$client.query<{ hash: string }>(
      'SELECT hash FROM drizzle.__drizzle_migrations',
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(new Set(rows.map((r) => r.hash)).size).toBe(rows.length);
  });
});
