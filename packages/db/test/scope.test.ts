import { createTestDb, type TestDb } from '@briefroom/db/testing';
import { pgTable, text } from 'drizzle-orm/pg-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { scoped } from '../src/scope.ts';

const workspaceNotes = pgTable('scope_ws_notes', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id').notNull(),
});

const projectNotes = pgTable('scope_project_notes', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id').notNull(),
  projectId: text('project_id').notNull(),
});

describe('scoped', () => {
  let t: TestDb;

  beforeAll(async () => {
    t = await createTestDb();
    await t.db.$client.query(
      `CREATE TABLE scope_ws_notes (id text PRIMARY KEY, workspace_id text NOT NULL);
       CREATE TABLE scope_project_notes (id text PRIMARY KEY, workspace_id text NOT NULL, project_id text NOT NULL);`,
    );
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

  it('rejects a table without workspace_id', () => {
    const bare = pgTable('bare', { id: text('id').primaryKey() });
    expect(() => scoped({ workspaceId: 'w1', visibleProjectIds: 'all' }, bare)).toThrow(
      /workspace_id/,
    );
  });
});
