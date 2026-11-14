import type { AddressInfo } from 'node:net';
import { createServer, type Server } from 'node:http';
import { workspaceBookmarks } from '@briefroom/db';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, makeInstallOwner, type TestApp } from './helpers.ts';

const PASSWORD = 'correct horse battery';

describe('workspace bookmarks', () => {
  let mine: TestApp;
  let host: TestApp;
  let hostBase: string;
  let hostWs: string;
  const cookies: Record<string, string> = {};
  const ids: Record<string, string> = {};
  const extra: Server[] = [];

  const http = () => request(mine.app.getHttpServer());
  const as = (who: string) => ({ cookie: cookies[who]! });
  const post = (inviteUrl: string, who = 'alice') =>
    http().post('/api/v1/bookmarks').set(as(who)).send({ inviteUrl });

  async function signIn(t: TestApp, email: string, name: string) {
    const created = await t.auth.api.createUser({ body: { email, password: PASSWORD, name } });
    const res = await t.auth.api.signInEmail({
      body: { email, password: PASSWORD },
      asResponse: true,
    });
    const cookie = res.headers
      .getSetCookie()
      .map((c) => c.split(';')[0])
      .join('; ');
    return { id: created.user.id, cookie };
  }

  async function newInvite(): Promise<string> {
    const res = await request(host.app.getHttpServer())
      .post(`/api/v1/workspaces/${hostWs}/invites`)
      .set({ cookie: cookies.hostOwner! })
      .send({});
    expect(res.status).toBe(201);
    return `${hostBase}/join/${res.body.url.split('/join/')[1]}`;
  }

  async function listenOn(handler: Parameters<typeof createServer>[1]): Promise<string> {
    const s = createServer(handler);
    extra.push(s);
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
    return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
  }

  beforeAll(async () => {
    mine = await createTestApp();
    host = await createTestApp();
    await host.app.listen(0, '127.0.0.1');
    hostBase = `http://127.0.0.1:${(host.app.getHttpServer().address() as AddressInfo).port}`;

    const owner = await signIn(host, 'hostowner@example.com', 'Host Owner');
    await makeInstallOwner(host, owner.id);
    cookies.hostOwner = owner.cookie;
    const ws = await request(host.app.getHttpServer())
      .post('/api/v1/workspaces')
      .set({ cookie: owner.cookie })
      .send({ name: 'Remote Acme' });
    expect(ws.status).toBe(201);
    hostWs = ws.body.id;

    for (const who of ['alice', 'bob', 'carol']) {
      const u = await signIn(mine, `${who}@example.com`, who);
      cookies[who] = u.cookie;
      ids[who] = u.id;
    }
  });

  afterAll(async () => {
    for (const s of extra) {
      s.closeAllConnections();
      s.close();
    }
    await host.close();
    await mine.close();
  });

  it('stores the host install id and workspace name and returns the join URL', async () => {
    const invite = await newInvite();
    const res = await post(invite);
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ id: expect.any(String), label: 'Remote Acme', joinUrl: invite });
    const hostVersion = await request(host.app.getHttpServer()).get('/api/version');
    const [row] = await mine.db.db
      .select()
      .from(workspaceBookmarks)
      .where(eq(workspaceBookmarks.id, res.body.id));
    expect(row).toMatchObject({
      userId: ids.alice,
      label: 'Remote Acme',
      remoteBaseUrl: hostBase,
      remoteInstallId: hostVersion.body.installId,
      remoteWorkspaceId: hostWs,
      createdBy: ids.alice,
    });
  });

  it('stores no column containing the token', async () => {
    const invite = await newInvite();
    const token = invite.split('/join/')[1]!;
    await post(invite);
    const rows = await mine.db.db.select().from(workspaceBookmarks);
    expect(JSON.stringify(rows)).not.toContain(token);
  });

  it('re-adding the same workspace returns the same id and keeps one row', async () => {
    const first = await post(await newInvite());
    const second = await post(await newInvite());
    expect(second.status).toBe(201);
    expect(second.body.id).toBe(first.body.id);
    const rows = await mine.db.db
      .select()
      .from(workspaceBookmarks)
      .where(eq(workspaceBookmarks.userId, ids.alice!));
    expect(rows.filter((r) => r.remoteWorkspaceId === hostWs)).toHaveLength(1);
  });

  it('gives 400 invite_invalid for an unknown token', async () => {
    const res = await post(`${hostBase}/join/not-a-real-token`, 'carol');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invite_invalid');
  });

  it('gives 400 invite_invalid for a revoked invite', async () => {
    const created = await request(host.app.getHttpServer())
      .post(`/api/v1/workspaces/${hostWs}/invites`)
      .set({ cookie: cookies.hostOwner! })
      .send({});
    await request(host.app.getHttpServer())
      .delete(`/api/v1/workspaces/${hostWs}/invites/${created.body.id}`)
      .set({ cookie: cookies.hostOwner! });
    const res = await post(`${hostBase}/join/${created.body.url.split('/join/')[1]}`, 'carol');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invite_invalid');
  });

  it.each(['file:///etc/join/abc', 'ftp://127.0.0.1/join/abc', 'http://u:p@127.0.0.1/join/abc'])(
    'gives 400 invalid_invite_url for %s',
    async (url) => {
      const res = await post(url, 'carol');
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('invalid_invite_url');
    },
  );

  it('gives 400 for a path without /join/<token>', async () => {
    const res = await post(`${hostBase}/somewhere/else`, 'carol');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_invite_url');
  });

  it('gives 502 host_unreachable for a closed port', async () => {
    const s = createServer();
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
    const port = (s.address() as AddressInfo).port;
    await new Promise((r) => s.close(r));
    const started = Date.now();
    const res = await post(`http://127.0.0.1:${port}/join/abc`, 'carol');
    expect(res.status).toBe(502);
    expect(res.body.code).toBe('host_unreachable');
    expect(Date.now() - started).toBeLessThan(6000);
  });

  it('gives 502 host_unreachable for a host that accepts but never answers', async () => {
    const base = await listenOn(() => undefined);
    const started = Date.now();
    const res = await post(`${base}/join/abc`, 'carol');
    expect(res.status).toBe(502);
    expect(res.body.code).toBe('host_unreachable');
    expect(Date.now() - started).toBeLessThan(6500);
  }, 15_000);

  it('gives 502 host_unreachable for a redirecting host', async () => {
    const base = await listenOn((_req, res) => {
      res.statusCode = 302;
      res.setHeader('location', 'http://127.0.0.1:1/elsewhere');
      res.end();
    });
    const res = await post(`${base}/join/abc`, 'carol');
    expect(res.status).toBe(502);
    expect(res.body.code).toBe('host_unreachable');
  });

  it('lists only the caller bookmarks', async () => {
    const mineRes = await post(await newInvite(), 'alice');
    const bobs = await http().get('/api/v1/bookmarks').set(as('bob'));
    expect(bobs.status).toBe(200);
    expect(bobs.body).toEqual([]);
    const alices = await http().get('/api/v1/bookmarks').set(as('alice'));
    expect(alices.body).toEqual([
      { id: mineRes.body.id, label: 'Remote Acme', remoteBaseUrl: hostBase },
    ]);
  });

  it("404s deleting another user's or a malformed id, and deletes your own", async () => {
    const made = await post(await newInvite(), 'alice');
    const del = (id: string, who: string) => http().delete(`/api/v1/bookmarks/${id}`).set(as(who));
    expect((await del(made.body.id, 'bob')).status).toBe(404);
    expect((await del('nope', 'alice')).status).toBe(404);
    expect((await del(made.body.id, 'alice')).status).toBe(204);
    expect((await del(made.body.id, 'alice')).status).toBe(404);
  });

  it('needs a session', async () => {
    const res = await request(mine.app.getHttpServer()).get('/api/v1/bookmarks');
    expect(res.status).toBe(401);
  });

  it('throttles POST to 10 a minute', async () => {
    let last = 0;
    for (let i = 0; i < 12; i++) last = (await post('ftp://x/join/a', 'bob')).status;
    expect(last).toBe(429);
  });
});
