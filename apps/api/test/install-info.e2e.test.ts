import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createTestApp, makeInstallOwner, type TestApp } from './helpers.ts';

const PASSWORD = 'correct horse battery';

interface Fixture {
  t: TestApp;
  cookies: Record<string, string>;
  installId: string;
  workspaceId: string;
}

async function setup(env: Record<string, string>): Promise<Fixture> {
  const t = await createTestApp(env);
  const cookies: Record<string, string> = {};
  const ids: Record<string, string> = {};
  for (const key of ['owner', 'admin']) {
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
  await t.auth.api.addMember({
    body: { userId: ids.admin!, role: 'admin', organizationId: ws.id },
  });
  const { rows } = await t.db.db.$client.query('SELECT id FROM install');
  return { t, cookies, installId: rows[0].id as string, workspaceId: ws.id };
}

describe.each([
  { bind: undefined, reach: 'local', warns: true },
  { bind: '127.0.0.1', reach: 'local', warns: true },
  { bind: '0.0.0.0', reach: 'lan', warns: false },
  { bind: '192.168.1.20', reach: 'lan', warns: false },
])('install info with BRIEFROOM_BIND=$bind', ({ bind, reach, warns }) => {
  let f: Fixture;
  const http = () => request(f.t.app.getHttpServer());

  beforeAll(async () => {
    f = await setup(bind === undefined ? {} : { BRIEFROOM_BIND: bind });
  });
  afterAll(async () => {
    await f.t.close();
  });

  it('gives the install owner the install details', async () => {
    const res = await http().get('/api/v1/install').set({ cookie: f.cookies.owner! });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      installId: f.installId,
      publicUrl: 'http://localhost:4300',
      reach,
      changeCommand: 'npx briefroom init',
    });
  });

  it(`${warns ? 'warns' : 'does not warn'} about reach when an invite is created`, async () => {
    const res = await http()
      .post(`/api/v1/workspaces/${f.workspaceId}/invites`)
      .set({ cookie: f.cookies.admin! })
      .send({});
    expect(res.status).toBe(201);
    if (warns) expect(res.body.warning).toBe('install_not_reachable');
    else expect(res.body).not.toHaveProperty('warning');
  });
});

describe('install info access', () => {
  let f: Fixture;
  const http = () => request(f.t.app.getHttpServer());

  beforeAll(async () => {
    f = await setup({});
  });
  afterAll(async () => {
    await f.t.close();
  });

  it('refuses a workspace admin who is not the install owner', async () => {
    const res = await http().get('/api/v1/install').set({ cookie: f.cookies.admin! });
    expect(res.status).toBe(403);
  });

  it('refuses a visitor with no session', async () => {
    expect((await http().get('/api/v1/install')).status).toBe(401);
  });
});
