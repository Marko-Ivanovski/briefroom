import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, makeInstallOwner, type TestApp } from './helpers.ts';

const PASSWORD = 'correct horse battery';

describe('module routes', () => {
  let t: TestApp;
  const cookies: Record<string, string> = {};
  let workspaceId: string;
  let otherWorkspaceId: string;

  const http = () => request(t.app.getHttpServer());
  const notes = (ws: string) => `/api/v1/workspaces/${ws}/m/testkit/notes`;

  beforeAll(async () => {
    t = await createTestApp();
    const ids: Record<string, string> = {};
    for (const key of ['owner', 'member', 'outsider']) {
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
    const ws = await t.auth.api.createOrganization({
      body: { name: 'Acme', slug: 'acme', userId: ids.owner! },
    });
    workspaceId = ws.id;
    await t.auth.api.addMember({
      body: { userId: ids.member!, role: 'member', organizationId: workspaceId },
    });
    const other = await t.auth.api.createOrganization({
      body: { name: 'Other', slug: 'other', userId: ids.owner! },
    });
    otherWorkspaceId = other.id;
  });

  afterAll(async () => {
    await t.close();
  });

  it('returns 404 to a non-member, as the global guard does everywhere else', async () => {
    const read = await http().get(notes(workspaceId)).set({ cookie: cookies.outsider! });
    const write = await http()
      .post(notes(workspaceId))
      .set({ cookie: cookies.outsider! })
      .send({ text: 'nope' });
    expect(read.status).toBe(404);
    expect(write.status).toBe(404);
  });

  it('refuses an anonymous caller', async () => {
    const res = await http().get(notes(workspaceId));
    expect(res.status).toBe(401);
  });

  it('lets a member create and list notes in their own workspace only', async () => {
    const created = await http()
      .post(notes(workspaceId))
      .set({ cookie: cookies.member! })
      .send({ text: 'first' });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ text: 'first', workspaceId, createdVia: 'web' });

    await http()
      .post(notes(otherWorkspaceId))
      .set({ cookie: cookies.owner! })
      .send({ text: 'elsewhere' });

    const list = await http().get(notes(workspaceId)).set({ cookie: cookies.member! });
    expect(list.status).toBe(200);
    expect(list.body.map((n: { text: string }) => n.text)).toEqual(['first']);
  });

  it('rejects a note without text', async () => {
    const res = await http().post(notes(workspaceId)).set({ cookie: cookies.member! }).send({});
    expect(res.status).toBe(400);
  });
});
