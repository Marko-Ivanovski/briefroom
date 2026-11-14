import { getTableColumns, getTableName } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { allTables, BETTER_AUTH_TABLES } from '../src/tables.ts';
import { createTestDb } from '../src/testing.ts';

const AUDIT = [
  'createdBy',
  'createdAt',
  'createdVia',
  'createdAgent',
  'updatedBy',
  'updatedAt',
  'updatedVia',
  'updatedAgent',
];

describe('schema contract', () => {
  it('every table outside Better Auth has the audit columns', () => {
    for (const t of allTables()) {
      if (BETTER_AUTH_TABLES.includes(getTableName(t))) continue;
      const cols = Object.keys(getTableColumns(t));
      for (const c of AUDIT) expect(cols, `${getTableName(t)}.${c}`).toContain(c);
    }
  });

  it('migrations apply to an empty database', async () => {
    const t = await createTestDb();
    await t.close();
  });
});
