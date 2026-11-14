import { createTestDb, type TestDb } from '@briefroom/db/testing';
import { pgTable, text } from 'drizzle-orm/pg-core';
import { afterAll, beforeAll, describe, expect, expectTypeOf, it } from 'vitest';
import { projects } from '../src/schema/projects.ts';
import {
  scopedInsert,
  scopedUpdate,
  scoped,
  scopedProjects,
  type WriteScope,
} from '../src/scope.ts';

const workspaceNotes = pgTable('scope_ws_notes', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id').notNull(),
});

const projectNotes = pgTable('scope_project_notes', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id').notNull(),
  projectId: text('project_id').notNull(),
});

const mixedNotes = pgTable('scope_mixed_notes', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id').notNull(),
  projectId: text('project_id'),
});

describe('scoped', () => {
  let t: TestDb;

  beforeAll(async () => {
    t = await createTestDb();
    await t.db.$client.query(
      `CREATE TABLE scope_ws_notes (id text PRIMARY KEY, workspace_id text NOT NULL);
       CREATE TABLE scope_project_notes (id text PRIMARY KEY, workspace_id text NOT NULL, project_id text NOT NULL);
       CREATE TABLE scope_mixed_notes (id text PRIMARY KEY, workspace_id text NOT NULL, project_id text);`,
    );
    await t.db.insert(mixedNotes).values([
      { id: 'wide', workspaceId: 'w1', projectId: null },
      { id: 'p1', workspaceId: 'w1', projectId: 'p1' },
      { id: 'p2', workspaceId: 'w1', projectId: 'p2' },
      { id: 'other', workspaceId: 'w2', projectId: null },
    ]);
    await t.db.insert(workspaceNotes).values([
      { id: 'a', workspaceId: 'w1' },
      { id: 'b', workspaceId: 'w2' },
    ]);
    await t.db.insert(projectNotes).values([
      { id: 'a', workspaceId: 'w1', projectId: 'p1' },
      { id: 'b', workspaceId: 'w1', projectId: 'p2' },
      { id: 'c', workspaceId: 'w2', projectId: 'p1' },
    ]);
  });

  afterAll(async () => {
    await t.close();
  });

  it('filters a table without project_id by workspace only, whatever the visible projects', async () => {
    const rows = await t.db
      .select()
      .from(workspaceNotes)
      .where(scoped({ workspaceId: 'w1', visibleProjectIds: [] }, workspaceNotes));
    expect(rows.map((r) => r.id)).toEqual(['a']);
  });

  it("filters by workspace only for a project table when visible projects is 'all'", async () => {
    const rows = await t.db
      .select()
      .from(projectNotes)
      .where(scoped({ workspaceId: 'w1', visibleProjectIds: 'all' }, projectNotes));
    expect(rows.map((r) => r.id).sort()).toEqual(['a', 'b']);
  });

  it('adds project_id IN (list) for a project table with a visible list', async () => {
    const rows = await t.db
      .select()
      .from(projectNotes)
      .where(scoped({ workspaceId: 'w1', visibleProjectIds: ['p2'] }, projectNotes));
    expect(rows.map((r) => r.id)).toEqual(['b']);
  });

  it('matches nothing for an empty visible list', async () => {
    const rows = await t.db
      .select()
      .from(projectNotes)
      .where(scoped({ workspaceId: 'w1', visibleProjectIds: [] }, projectNotes));
    expect(rows).toEqual([]);
  });

  describe('a table whose project_id is nullable', () => {
    const ids = async (visibleProjectIds: 'all' | string[]) =>
      (
        await t.db
          .select()
          .from(mixedNotes)
          .where(scoped({ workspaceId: 'w1', visibleProjectIds }, mixedNotes))
      )
        .map((r) => r.id)
        .sort();

    it('shows only workspace-wide rows to a member with no visible projects', async () => {
      expect(await ids([])).toEqual(['wide']);
    });

    it('shows workspace-wide rows plus the visible projects', async () => {
      expect(await ids(['p1'])).toEqual(['p1', 'wide']);
    });

    it("shows every row of the workspace for 'all'", async () => {
      expect(await ids('all')).toEqual(['p1', 'p2', 'wide']);
    });
  });

  it('rejects a table without workspace_id at the type level and at runtime', () => {
    const bare = pgTable('bare', { id: text('id').primaryKey() });
    expect(() =>
      // @ts-expect-error a table without a workspaceId column is not a ScopedTable
      scoped({ workspaceId: 'w1', visibleProjectIds: 'all' }, bare),
    ).toThrow(/workspace_id/);
  });
});

describe('scopedInsert and scopedUpdate', () => {
  const scope: WriteScope = {
    workspaceId: 'w1',
    actor: { userId: 'u1', via: 'mcp', agent: 'claude' },
  };

  it('insert takes workspaceId from the scope, overriding the caller', () => {
    const row = scopedInsert(scope, { id: 'a', workspaceId: 'w-evil' });
    expect(row.workspaceId).toBe('w1');
    expect(row.id).toBe('a');
  });

  it('insert adds the created and updated stamps', () => {
    const row = scopedInsert(scope, { id: 'a' });
    expect(row).toMatchObject({
      createdBy: 'u1',
      createdVia: 'mcp',
      createdAgent: 'claude',
      updatedBy: 'u1',
      updatedVia: 'mcp',
      updatedAgent: 'claude',
    });
    expect(row.createdAt).toBeInstanceOf(Date);
  });

  it('update adds only the updated stamp', () => {
    const row = scopedUpdate(scope, { title: 'x' });
    expect(row).toMatchObject({ title: 'x', updatedBy: 'u1', updatedVia: 'mcp' });
    expect(row).not.toHaveProperty('createdBy');
    expect(row).not.toHaveProperty('workspaceId');
  });

  it('insert types workspaceId as string even when the caller passes a literal', () => {
    const row = scopedInsert(scope, { id: 'a', workspaceId: 'w-evil' });
    expectTypeOf(row.workspaceId).toEqualTypeOf<string>();
  });

  it('update throws when values contain workspaceId', () => {
    // @ts-expect-error workspaceId is rejected at compile time
    expect(() => scopedUpdate(scope, { workspaceId: 'w2' })).toThrow(/workspaceId/);
  });

  it.each(['createdBy', 'createdAt', 'createdVia', 'createdAgent'])(
    'update throws when values contain %s',
    (key) => {
      // @ts-expect-error creation audit columns are rejected at compile time
      expect(() => scopedUpdate(scope, { [key]: 'x', createdBy: 'x' })).toThrow(/created/);
    },
  );

  it('update rejects the creation audit fields at the type level', () => {
    // @ts-expect-error createdBy is rejected at compile time
    expect(() => scopedUpdate(scope, { createdBy: 'x' })).toThrow();
    // @ts-expect-error createdAt is rejected at compile time
    expect(() => scopedUpdate(scope, { createdAt: new Date() })).toThrow();
  });
});

describe('scopedProjects', () => {
  let t: TestDb;
  const P1 = '11111111-1111-4111-8111-111111111111';
  const P2 = '22222222-2222-4222-8222-222222222222';
  const P3 = '33333333-3333-4333-8333-333333333333';

  beforeAll(async () => {
    t = await createTestDb();
    const c = await t.db.$client.connect();
    try {
      await c.query(`SET session_replication_role = replica`);
      for (const [id, ws] of [
        [P1, 'w1'],
        [P2, 'w1'],
        [P3, 'w2'],
      ]) {
        await c.query(
          `INSERT INTO projects (id, workspace_id, name, created_by, created_via, updated_by, updated_via)
           VALUES ($1, $2, 'n', 'u', 'web', 'u', 'web')`,
          [id, ws],
        );
      }
    } finally {
      c.release(true);
    }
  });

  afterAll(async () => {
    await t.close();
  });

  const ids = async (workspaceId: string, visibleProjectIds: 'all' | string[]) =>
    (
      await t.db
        .select({ id: projects.id })
        .from(projects)
        .where(scopedProjects({ workspaceId, visibleProjectIds }))
    )
      .map((r) => r.id)
      .sort();

  it("returns every project of the workspace for 'all'", async () => {
    expect(await ids('w1', 'all')).toEqual([P1, P2]);
  });

  it('returns only the listed projects of the workspace', async () => {
    expect(await ids('w1', [P1])).toEqual([P1]);
    expect(await ids('w1', [P1, P3])).toEqual([P1]);
  });

  it('returns nothing for an empty list', async () => {
    expect(await ids('w1', [])).toEqual([]);
  });
});
