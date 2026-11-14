import { projectMembers, recordHistory, scopedInsert } from '@briefroom/db';
import { and, eq } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WorkspaceModulesService } from '../src/module-registry/workspace-modules.service.ts';
import { createTestApp, makeInstallOwner, type TestApp } from './helpers.ts';

const PASSWORD = 'correct horse battery';

describe('change history', () => {
  let t: TestApp;
  let ws: string;
  let projectId: string;
  const ids: Record<string, string> = {};
  const cookies: Record<string, string> = {};

  const http = () => request(t.app.getHttpServer());
  const base = () => `/api/v1/workspaces/${ws}`;
  const as = (who: string) => ({ cookie: cookies[who]! });
  const notes = () => `${base()}/m/testkit/notes`;
  const history = (who: string, table: string, id: string) =>
    http().get(`${base()}/history/${table}/${id}`).set(as(who));
  const createNote = async (who: string, body: object) =>
    (await http().post(notes()).set(as(who)).send(body)).body as { id: string };
  const edit = (who: string, id: string, text: string) =>
    http().patch(`${notes()}/${id}`).set(as(who)).send({ text });

  beforeAll(async () => {
    t = await createTestApp();
    for (const key of ['owner', 'writer', 'reader', 'outsider']) {
      const { user } = await t.auth.api.createUser({
        body: { email: `${key}@example.com`, password: PASSWORD, name: key },
      });
      ids[key] = user.id;
      const res = await t.auth.api.signInEmail({
        body: { email: `${key}@example.com`, password: PASSWORD },
        asResponse: true,
      });
      cookies[key] = res.headers
        .getSetCookie()
        .map((c) => c.split(';')[0])
        .join('; ');
    }
    await makeInstallOwner(t, ids.owner!);
    ws = (
      await t.auth.api.createOrganization({
        body: { name: 'Acme', slug: 'acme', userId: ids.owner! },
      })
    ).id;
    for (const key of ['writer', 'reader']) {
      await t.auth.api.addMember({
        body: { userId: ids[key]!, role: 'member', organizationId: ws },
      });
    }
    const actor = { userId: ids.owner!, via: 'web' } as const;
    await t.app.get(WorkspaceModulesService).enableStarting(ws, actor, ['testkit']);
    await http()
      .put(`${base()}/members/${ids.writer}/permissions`)
      .set(as('owner'))
      .send({ moduleId: 'testkit', key: 'write-notes', granted: true });
    projectId = (await http().post(`${base()}/projects`).set(as('owner')).send({ name: 'P' })).body
      .id;
    await t.db.db
      .insert(projectMembers)
      .values(scopedInsert({ workspaceId: ws, actor }, { projectId, userId: ids.writer! }));
  });

  afterAll(async () => {
    await t.close();
  });

  it('records a creation and two edits, newest first, with who and how', async () => {
    const note = await createNote('writer', { text: 'v1', projectId });
    expect((await edit('writer', note.id, 'v2')).status).toBe(200);
    expect((await edit('writer', note.id, 'v3')).status).toBe(200);

    const res = await history('writer', 'testkit_notes', note.id);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(3);
    expect(res.body[0]).toMatchObject({
      actorId: ids.writer,
      actorName: 'writer',
      via: 'web',
      agent: null,
      changes: { text: { from: 'v2', to: 'v3' } },
    });
    expect(res.body[1].changes).toEqual({ text: { from: 'v1', to: 'v2' } });
    expect(res.body[2].changes.text).toEqual({ from: null, to: 'v1' });
    expect(typeof res.body[0].at).toBe('string');
    expect(res.body[0]).not.toHaveProperty('workspaceId');
  });

  it('writes nothing for an edit that changes nothing', async () => {
    const note = await createNote('writer', { text: 'same', projectId });
    expect((await edit('writer', note.id, 'same')).status).toBe(200);
    const rows = await t.db.db
      .select()
      .from(recordHistory)
      .where(eq(recordHistory.recordId, note.id));
    expect(rows).toHaveLength(1);
  });

  it('answers 404 to a member who cannot see the note project', async () => {
    const note = await createNote('writer', { text: 'secret', projectId });
    expect((await history('reader', 'testkit_notes', note.id)).status).toBe(404);
    expect((await history('owner', 'testkit_notes', note.id)).status).toBe(200);
    expect((await edit('reader', note.id, 'nope')).status).toBe(403);
  });

  it('shows workspace-level note history to a member who is on no project', async () => {
    const note = await createNote('writer', { text: 'open' });
    const res = await history('reader', 'testkit_notes', note.id);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
  });

  it('answers 404 for an unknown table, a table that is not opted in, and a bad id', async () => {
    const note = await createNote('writer', { text: 'x' });
    expect((await history('owner', 'nope', note.id)).status).toBe(404);
    expect((await history('owner', 'record_history', note.id)).status).toBe(404);
    expect((await history('owner', 'testkit_notes', 'not-a-uuid')).status).toBe(404);
  });

  it('answers 404 to a non-member and 401 to nobody', async () => {
    const note = await createNote('writer', { text: 'x' });
    expect((await history('outsider', 'testkit_notes', note.id)).status).toBe(404);
    expect((await http().get(`${base()}/history/testkit_notes/${note.id}`)).status).toBe(401);
  });

  it('answers 409 module_off when the table module is switched off', async () => {
    const note = await createNote('writer', { text: 'x' });
    await http().put(`${base()}/modules/testkit`).set(as('owner')).send({ enabled: false });
    const res = await history('owner', 'testkit_notes', note.id);
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'module_off', moduleId: 'testkit' });
    await http().put(`${base()}/modules/testkit`).set(as('owner')).send({ enabled: true });
    expect((await history('owner', 'testkit_notes', note.id)).status).toBe(200);
  });

  it('keeps one workspace history out of another', async () => {
    const note = await createNote('writer', { text: 'x' });
    const other = (
      await t.auth.api.createOrganization({
        body: { name: 'Other', slug: 'other', userId: ids.owner! },
      })
    ).id;
    await t.app
      .get(WorkspaceModulesService)
      .enableStarting(other, { userId: ids.owner!, via: 'web' }, ['testkit']);
    const res = await http()
      .get(`/api/v1/workspaces/${other}/history/testkit_notes/${note.id}`)
      .set(as('owner'));
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('stamps history rows with the audit columns and the workspace', async () => {
    const note = await createNote('writer', { text: 'audit' });
    const [row] = await t.db.db
      .select()
      .from(recordHistory)
      .where(and(eq(recordHistory.recordId, note.id), eq(recordHistory.workspaceId, ws)));
    expect(row).toMatchObject({
      tableName: 'testkit_notes',
      actorId: ids.writer,
      via: 'web',
      createdBy: ids.writer,
      createdVia: 'web',
    });
  });
});
