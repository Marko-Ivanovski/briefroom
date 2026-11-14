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

// Tables that belong to the install, not to a workspace. Add install-level tables here.
const INSTALL_LEVEL_TABLES: readonly string[] = ['install', 'cli_logins', 'remote_access'];

describe('schema contract', () => {
  it('registers tables in the schema index', () => {
    expect(allTables().length).toBeGreaterThan(0);
  });

  it('every Better Auth table is exported with its expected name', () => {
    const names = allTables().map((t) => getTableName(t));
    for (const name of BETTER_AUTH_TABLES) expect(names).toContain(name);
  });

  it('every table outside Better Auth has the audit columns', () => {
    const checked = allTables().filter((t) => !BETTER_AUTH_TABLES.includes(getTableName(t)));
    expect(checked.map((t) => getTableName(t))).toContain('install');
    for (const t of checked) {
      const cols = Object.keys(getTableColumns(t));
      for (const c of AUDIT) expect(cols, `${getTableName(t)}.${c}`).toContain(c);
    }
  });

  it('every other table carries workspace_id', () => {
    const checked = allTables().filter((t) => {
      const name = getTableName(t);
      return !BETTER_AUTH_TABLES.includes(name) && !INSTALL_LEVEL_TABLES.includes(name);
    });
    expect(checked.map((t) => getTableName(t))).toContain('projects');
    for (const t of checked) {
      const cols = Object.values(getTableColumns(t)).map((c) => c.name);
      expect(cols, `${getTableName(t)}.workspace_id`).toContain('workspace_id');
    }
  });

  it('refuses an access checklist kind other than add or remove', async () => {
    const t = await createTestDb();
    try {
      const insert = (kind: string) =>
        t.db.$client.query(
          `INSERT INTO project_access_checklist
             (workspace_id, project_id, user_id, tool_link_id, kind, created_by, updated_by, created_via, updated_via)
           VALUES ('w', gen_random_uuid(), 'u', gen_random_uuid(), $1, 'u', 'u', 'web', 'web')`,
          [kind],
        );
      await expect(insert('bogus')).rejects.toMatchObject({ code: '23514' });
      await expect(insert('add')).rejects.toMatchObject({ code: '23503' });
    } finally {
      await t.close();
    }
  });

  it('migrations apply to an empty database', async () => {
    const t = await createTestDb();
    await t.close();
  });
});
