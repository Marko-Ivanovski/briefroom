import { projectMembers } from '@briefroom/db';
import { and, eq } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, makeInstallOwner, type TestApp } from './helpers.ts';

const PASSWORD = 'correct horse battery';

describe('project membership and visibility', () => {
  let t: TestApp;
  let ws: string;
  let ws2: string;
  let projectId: string;
  const ids: Record<string, string> = {};
  const cookies: Record<string, string> = {};

  const http = () => request(t.app.getHttpServer());
  const base = (w = ws) => `/api/v1/workspaces/${w}`;
  const as = (who: string) => ({ cookie: cookies[who]! });
  const members = (p = projectId) => `${base()}/projects/${p}/members`;
  const add = (who: string, userId: string, p = projectId) =>
    http().post(members(p)).set(as(who)).send({ userId });
  const remove = (who: string, userId: string) =>
    http().delete(`${members()}/${userId}`).set(as(who));
  const leave = (who: string) => http().post(`${members()}/leave`).set(as(who));
  const getProject = (who: string, p = projectId) =>
    http().get(`${base()}/projects/${p}`).set(as(who));
  const listIds = async (who: string) =>
    (await http().get(`${base()}/projects`).set(as(who))).body.map((p: { id: string }) => p.id);

  beforeAll(async () => {
    t = await createTestApp();
    for (const key of ['owner', 'admin', 'member', 'other', 'outsider']) {
      const email = `${key}@example.com`;
      const { user } = await t.auth.api.createUser({
        body: { email, password: PASSWORD, name: key },
      });
      ids[key] = user.id;
      const res = await t.auth.api.signInEmail({
        body: { email, password: PASSWORD },
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
    ws2 = (
      await t.auth.api.createOrganization({
        body: { name: 'Other', slug: 'other', userId: ids.owner! },
      })
    ).id;
    for (const key of ['admin', 'member', 'other']) {
      await t.auth.api.addMember({
        body: {
          userId: ids[key]!,
          role: key === 'admin' ? 'admin' : 'member',
          organizationId: ws,
        },
      });
    }
    await t.auth.api.addMember({
      body: { userId: ids.outsider!, role: 'member', organizationId: ws2 },
    });
    const created = await http().post(`${base()}/projects`).set(as('admin')).send({ name: 'P' });
    projectId = created.body.id;
  });

  afterAll(async () => {
    await t.close();
  });

  it('hides a project from a member who is not on it', async () => {
    expect((await getProject('member')).status).toBe(404);
    expect(await listIds('member')).not.toContain(projectId);
    expect((await http().get(members()).set(as('member'))).status).toBe(404);
  });

  it('shows every project to owners and admins without membership', async () => {
    expect((await getProject('owner')).status).toBe(200);
    expect(await listIds('owner')).toContain(projectId);
    expect((await getProject('admin')).status).toBe(200);
  });

  it('lets an admin add a member, who then sees the project, and remove them again', async () => {
    const added = await add('admin', ids.member!);
    expect(added.status).toBe(201);
    expect(added.body).toMatchObject({
      userId: ids.member,
      name: 'member',
      email: 'member@example.com',
    });
    expect(typeof added.body.addedAt).toBe('string');

    expect((await getProject('member')).status).toBe(200);
    expect(await listIds('member')).toContain(projectId);

    const list = await http().get(members()).set(as('member'));
    expect(list.status).toBe(200);
    expect(list.body.map((m: { userId: string }) => m.userId)).toEqual(
      expect.arrayContaining([ids.admin, ids.member]),
    );

    expect((await remove('admin', ids.member!)).status).toBe(204);
    expect((await getProject('member')).status).toBe(404);
    expect(await listIds('member')).not.toContain(projectId);
  });

  it('refuses member-role callers on add and remove', async () => {
    expect((await add('member', ids.other!)).status).toBe(403);
    expect((await remove('member', ids.other!)).status).toBe(403);
  });

  it('answers 400 not_a_workspace_member for a user outside the workspace', async () => {
    const res = await add('admin', ids.outsider!);
    expect(res.status).toBe(400);
    expect(res.body.message).toBe('not_a_workspace_member');
    const unknown = await add('admin', 'no-such-user');
    expect(unknown.status).toBe(400);
  });

  it('answers 409 already_on_project when the user is already on the project (R72)', async () => {
    expect((await add('admin', ids.other!)).status).toBe(201);
    const again = await add('admin', ids.other!);
    expect(again.status).toBe(409);
    expect(again.body.message).toBe('already_on_project');
  });

  it('answers 404 when removing a user who is not on the project', async () => {
    expect((await remove('admin', ids.member!)).status).toBe(404);
  });

  it('ends access on the leaver next request when a member leaves', async () => {
    await add('admin', ids.member!);
    expect((await getProject('member')).status).toBe(200);
    expect((await leave('member')).status).toBe(204);
    expect((await getProject('member')).status).toBe(404);
    expect((await leave('member')).status).toBe(404);
  });

  it('lets an admin leave a project and still see it', async () => {
    expect((await leave('admin')).status).toBe(204);
    expect((await getProject('admin')).status).toBe(200);
    const rows = await t.db.db
      .select()
      .from(projectMembers)
      .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, ids.admin!)));
    expect(rows).toHaveLength(0);
  });

  it('treats a malformed or foreign project id as 404', async () => {
    expect((await http().get(members('nope')).set(as('admin'))).status).toBe(404);
    expect((await add('admin', ids.member!, 'nope')).status).toBe(404);
    expect(
      (
        await http()
          .get(`${base(ws2)}/projects/${projectId}/members`)
          .set(as('admin'))
      ).status,
    ).toBe(404);
  });
});
