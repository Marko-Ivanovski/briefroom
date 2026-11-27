import { cliLogins, remoteAccess } from '@briefroom/db';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { fakeSpawn, flush, healthyTunnels } from './fake-child.ts';
import { listenOnTunnelSocket } from '../src/auth/proxy-socket.ts';
import { RemoteAccessService } from '../src/remote-access/remote-access.service.ts';
import { createTestApp, makeInstallOwner, resetThrottle, type TestApp } from './helpers.ts';
import { testTunnelSocket, viaTunnel } from './tunnel-request.ts';

const PASSWORD = 'correct horse battery';
const TOKEN = 'eyJhIjoiYWNjb3VudCIsInQiOiJ0dW5uZWwiLCJzIjoic2VjcmV0LXRva2VuIn0=';
const TS_KEY = 'tskey-auth-kFAKE1CNTRL-abcdefghijklmnop';
const TUNNEL = 'https://briefroom.tunnel.example';
const ENDPOINT = '/api/v1/install/remote-access';

describe('remote access', () => {
  let t: TestApp;
  let spawned: ReturnType<typeof fakeSpawn>;
  let workspaceId: string;
  const socketPath = testTunnelSocket();
  const ids: Record<string, string> = {};
  const cookies: Record<string, string> = {};
  const seen: string[] = [];

  // Every response body and header is kept, so the last test can prove no secret ever left.
  const http = () => request(t.app.getHttpServer());
  const record = <R extends { text: string; headers: unknown }>(res: R): R => {
    seen.push(res.text, JSON.stringify(res.headers));
    return res;
  };
  const as = (who: string) => ({ cookie: cookies[who]! });
  const get = async (who = 'owner') => record(await http().get(ENDPOINT).set(as(who)));
  const put = async (body: object, who = 'owner') =>
    record(await http().put(ENDPOINT).set(as(who)).send(body));
  const install = async () => record(await http().get('/api/v1/install').set(as('owner')));

  async function waitForStatus(status: string): Promise<void> {
    for (let i = 0; i < 50; i++) {
      if ((await get()).body.status === status) return;
      await flush();
    }
    throw new Error(`remote access never reached ${status}`);
  }

  async function switchOn(body: object): Promise<void> {
    expect((await put(body)).status).toBe(200);
    await waitForStatus('running');
  }

  async function switchOff(): Promise<void> {
    expect((await put({ mode: 'off' })).status).toBe(200);
  }

  async function addUser(key: string): Promise<void> {
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

  beforeAll(async () => {
    spawned = fakeSpawn(healthyTunnels);
    t = await createTestApp({}, [], [], true, spawned.spawn);
    // Listening first keeps supertest from closing the server, and the tunnel socket with it.
    await t.app.listen(0, '127.0.0.1');
    await listenOnTunnelSocket(t.app.getHttpServer(), socketPath);
    await addUser('owner');
    await addUser('admin');
    await makeInstallOwner(t, ids.owner!);
    workspaceId = (
      await t.auth.api.createOrganization({
        body: { name: 'Acme', slug: 'acme', userId: ids.owner! },
      })
    ).id;
    await t.auth.api.addMember({
      body: { userId: ids.admin!, role: 'admin', organizationId: workspaceId },
    });
  });

  afterAll(async () => {
    await t.close();
  });

  beforeEach(async () => {
    resetThrottle(t);
    await switchOff();
  });

  describe('settings', () => {
    it('starts switched off', async () => {
      const res = await get();
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        mode: 'off',
        publicUrl: null,
        status: 'off',
        lastError: null,
        hasSecret: false,
      });
    });

    it('refuses a workspace admin who is not the install owner with 403', async () => {
      expect((await get('admin')).status).toBe(403);
      const res = await put({ mode: 'cloudflare', secret: TOKEN, publicUrl: TUNNEL }, 'admin');
      expect(res.status).toBe(403);
      expect(spawned.calls.filter((c) => c.options.env.TUNNEL_TOKEN === TOKEN)).toHaveLength(0);
    });

    it('refuses a visitor with no session', async () => {
      expect((await http().get(ENDPOINT)).status).toBe(401);
      expect((await http().put(ENDPOINT).send({ mode: 'off' })).status).toBe(401);
    });

    it.each([
      [{ mode: 'cloudflare', publicUrl: TUNNEL }, /secret/i],
      [{ mode: 'cloudflare', secret: TOKEN }, /publicUrl/i],
      [
        { mode: 'cloudflare', secret: TOKEN, publicUrl: 'http://briefroom.tunnel.example' },
        /https/,
      ],
      [{ mode: 'cloudflare', secret: TOKEN, publicUrl: `${TUNNEL}/app` }, /path/i],
      [{ mode: 'funnel', secret: TS_KEY, publicUrl: `${TUNNEL}:8443` }, /443/],
      // M1: Better Auth would read `*` as a wildcard origin.
      [{ mode: 'cloudflare', secret: TOKEN, publicUrl: 'https://*' }, /wildcard/],
      [{ mode: 'cloudflare', secret: TOKEN, publicUrl: 'https://*.example.com' }, /wildcard/],
      [{ mode: 'cloudflare', secret: TOKEN, publicUrl: 'https://localhost' }, /DNS labels/],
      [{ mode: 'cloudflare', secret: TOKEN, publicUrl: 'https://a@briefroom.example.com' }, /path/],
      [{ mode: 'nope' }, /mode/i],
    ])('rejects %j with 400', async (body, message) => {
      const res = await put(body);
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(message);
    });

    it('starts cloudflared with the token, and answers without the token', async () => {
      const res = await put({ mode: 'cloudflare', secret: TOKEN, publicUrl: `${TUNNEL}/` });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ mode: 'cloudflare', publicUrl: TUNNEL, hasSecret: true });
      expect(res.body).not.toHaveProperty('secret');
      expect(spawned.last().command).toBe('/usr/local/bin/cloudflared');
      expect(spawned.last().options.env.TUNNEL_TOKEN).toBe(TOKEN);
      await waitForStatus('running');
    });

    it('stores the secret sealed, never in plain text', async () => {
      await switchOn({ mode: 'cloudflare', secret: TOKEN, publicUrl: TUNNEL });
      const [row] = await t.db.db.select().from(remoteAccess);
      expect(row!.secretCiphertext).toMatch(/^v1\./);
      expect(JSON.stringify(row)).not.toContain(TOKEN);
      expect(row).toMatchObject({ mode: 'cloudflare', status: 'running', createdBy: ids.owner });
    });

    it('keeps the stored secret when only the tailscale flavour changes', async () => {
      await switchOn({ mode: 'tailscale', secret: TS_KEY, publicUrl: TUNNEL });
      await switchOn({ mode: 'funnel', publicUrl: TUNNEL });
      const up = spawned.calls.filter((c) => c.args.includes('up')).at(-1)!;
      expect(up.child.stdinText).toBe(TS_KEY);
      expect(spawned.last().args).toContain('funnel');
    });

    it('needs a new secret to move from tailscale to cloudflare', async () => {
      await switchOn({ mode: 'tailscale', secret: TS_KEY, publicUrl: TUNNEL });
      const res = await put({ mode: 'cloudflare', publicUrl: TUNNEL });
      expect(res.status).toBe(400);
    });

    it('switching off stops the children, forgets the secret and keeps the address', async () => {
      await switchOn({ mode: 'cloudflare', secret: TOKEN, publicUrl: TUNNEL });
      const child = spawned.last().child;
      const res = await put({ mode: 'off' });
      expect(res.body).toEqual({
        mode: 'off',
        publicUrl: TUNNEL,
        status: 'off',
        lastError: null,
        hasSecret: false,
      });
      expect(child.signals).toContain('SIGTERM');
    });

    it('reports a crashed tunnel without leaking the secret', async () => {
      await switchOn({ mode: 'cloudflare', secret: TOKEN, publicUrl: TUNNEL });
      spawned.last().child.complain(`ERR token ${TOKEN} refused`);
      spawned.last().child.exit(1);
      await waitForStatus('restarting');
      const res = await get();
      expect(res.body.lastError).toContain('[redacted]');
      const [row] = await t.db.db.select().from(remoteAccess);
      expect(row!.lastError).not.toContain(TOKEN);
    });
  });

  describe('the active public address', () => {
    it('is the tunnel address in install info, and reach is the tunnel mode', async () => {
      expect((await install()).body).toMatchObject({
        publicUrl: 'http://localhost:4300',
        reach: 'local',
      });
      await switchOn({ mode: 'cloudflare', secret: TOKEN, publicUrl: TUNNEL });
      expect((await install()).body).toMatchObject({ publicUrl: TUNNEL, reach: 'cloudflare' });
      await switchOff();
      expect((await install()).body).toMatchObject({ reach: 'local' });
    });

    it.each(['tailscale', 'funnel'] as const)('reports reach %s', async (mode) => {
      await switchOn({ mode, secret: TS_KEY, publicUrl: TUNNEL });
      expect((await install()).body.reach).toBe(mode);
    });

    it('builds invite links on the tunnel address and drops the reach warning', async () => {
      const before = await http()
        .post(`/api/v1/workspaces/${workspaceId}/invites`)
        .set(as('admin'))
        .send({});
      expect(before.body.warning).toBe('install_not_reachable');
      await switchOn({ mode: 'cloudflare', secret: TOKEN, publicUrl: TUNNEL });
      const res = await http()
        .post(`/api/v1/workspaces/${workspaceId}/invites`)
        .set(as('admin'))
        .send({});
      expect(res.status).toBe(201);
      expect(res.body.url.startsWith(`${TUNNEL}/join/`)).toBe(true);
      expect(res.body).not.toHaveProperty('warning');
    });

    it('builds reset links and cli-login urls on the tunnel address', async () => {
      await switchOn({ mode: 'cloudflare', secret: TOKEN, publicUrl: TUNNEL });
      const reset = await http()
        .post(`/api/v1/workspaces/${workspaceId}/members/${ids.admin}/reset-link`)
        .set(as('owner'));
      expect(reset.status).toBe(201);
      expect(reset.body.url.startsWith(`${TUNNEL}/reset/`)).toBe(true);
      const login = await http().post('/api/v1/cli-login').send({});
      expect(login.body.approveUrl).toBe(`${TUNNEL}/connect`);
    });

    it('lets sign-in through the tunnel origin while it runs, without a restart', async () => {
      const signIn = () =>
        http()
          .post('/api/auth/sign-in/email')
          .set({ origin: TUNNEL, 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors' })
          .send({ email: 'owner@example.com', password: PASSWORD });
      expect((await signIn()).status).toBe(403);
      await switchOn({ mode: 'cloudflare', secret: TOKEN, publicUrl: TUNNEL });
      const res = await signIn();
      expect(res.status).toBe(200);
      expect(res.headers['set-cookie']).toBeDefined();
      await switchOff();
      expect((await signIn()).status).toBe(403);
    });

    it('lets our own mutation routes accept the tunnel origin only while it runs', async () => {
      const post = () =>
        http()
          .post(`/api/v1/workspaces/${workspaceId}/invites`)
          .set({ ...as('admin'), origin: TUNNEL })
          .send({});
      expect((await post()).status).toBe(403);
      await switchOn({ mode: 'cloudflare', secret: TOKEN, publicUrl: TUNNEL });
      expect((await post()).status).toBe(201);
    });
  });

  describe('forwarded client address (R170, R185)', () => {
    const tunnel = (method: string, path: string, headers: Record<string, string>, body?: object) =>
      viaTunnel(socketPath, method, path, { headers, body: body ?? {} });
    const preview = (code: string, ip: string) =>
      tunnel(
        'POST',
        '/api/v1/cli-login/preview',
        { ...as('owner'), 'x-forwarded-for': ip },
        { code },
      );
    const startIp = async () => {
      const [row] = await t.db.db.select().from(cliLogins);
      await t.db.db.delete(cliLogins);
      return row!.startIp;
    };

    it('is ignored from loopback TCP while no tunnel runs', async () => {
      await http().post('/api/v1/cli-login').set('x-forwarded-for', '198.51.100.7').send({});
      expect(await startIp()).not.toBe('198.51.100.7');
    });

    it.each(['tailscale', 'funnel'] as const)(
      'is ignored from loopback TCP while %s runs, as from a tailnet peer through netstack',
      async (mode) => {
        await switchOn({ mode, secret: TS_KEY, publicUrl: TUNNEL });
        const res = await http()
          .post('/api/auth/sign-in/email')
          .set({ 'x-forwarded-for': '198.51.100.7', 'x-forwarded-proto': 'https' })
          .send({ email: 'admin@example.com', password: PASSWORD });
        expect(res.status).toBe(200);
        for (const c of res.headers['set-cookie'] as unknown as string[]) {
          expect(c).not.toMatch(/;\s*Secure/i);
        }
        await http().post('/api/v1/cli-login').set('x-forwarded-for', '198.51.100.7').send({});
        expect(await startIp()).not.toBe('198.51.100.7');
      },
    );

    it('records the forwarded cli-login start address on the socket and compares it on preview (R159)', async () => {
      await switchOn({ mode: 'tailscale', secret: TS_KEY, publicUrl: TUNNEL });
      const started = record(
        await tunnel('POST', '/api/v1/cli-login', { 'x-forwarded-for': '10.9.9.9, 198.51.100.7' }),
      );
      expect(started.status).toBe(201);
      const same = await preview(started.body.code, '198.51.100.7');
      expect(same.body).toMatchObject({ startIp: '198.51.100.7', sameIpAsYou: true });
      expect((await preview(started.body.code, '203.0.113.50')).body.sameIpAsYou).toBe(false);
      await t.db.db.delete(cliLogins);
    });

    it('prefers CF-Connecting-IP behind cloudflared', async () => {
      await switchOn({ mode: 'cloudflare', secret: TOKEN, publicUrl: TUNNEL });
      await tunnel('POST', '/api/v1/cli-login', {
        'cf-connecting-ip': '203.0.113.77',
        'x-forwarded-for': '198.51.100.1',
      });
      expect(await startIp()).toBe('203.0.113.77');
    });

    it('does not take CF-Connecting-IP from a tailscale tunnel', async () => {
      await switchOn({ mode: 'funnel', secret: TS_KEY, publicUrl: TUNNEL });
      await tunnel('POST', '/api/v1/cli-login', {
        'cf-connecting-ip': '203.0.113.77',
        'x-forwarded-for': '198.51.100.1',
      });
      expect(await startIp()).toBe('198.51.100.1');
    });

    it('still overwrites an incoming x-briefroom-client-ip', async () => {
      await switchOn({ mode: 'tailscale', secret: TS_KEY, publicUrl: TUNNEL });
      await tunnel('POST', '/api/v1/cli-login', {
        'x-briefroom-client-ip': '10.1.1.1',
        'x-forwarded-for': '198.51.100.8',
      });
      expect(await startIp()).toBe('198.51.100.8');
    });
  });

  describe('public mode defaults (R174)', () => {
    const signIn = (ip: string, extra: Record<string, string> = {}) =>
      viaTunnel(socketPath, 'POST', '/api/auth/sign-in/email', {
        headers: { 'x-forwarded-for': ip, ...extra },
        body: { email: 'owner@example.com', password: PASSWORD },
      });
    const cookiesOf = (res: { headers: { 'set-cookie'?: string[] } }) =>
      res.headers['set-cookie'] ?? [];

    it('rate limits sign-in per forwarded client, and a prepended address does not dodge it', async () => {
      await switchOn({ mode: 'cloudflare', secret: TOKEN, publicUrl: TUNNEL });
      for (let i = 0; i < 5; i++) expect((await signIn('203.0.113.10')).status).toBe(200);
      expect((await signIn('203.0.113.10')).status).toBe(429);
      expect((await signIn('198.51.100.99, 203.0.113.10')).status).toBe(429);
      expect((await signIn('203.0.113.11')).status).toBe(200);
    });

    it('rate limits the public invite routes per forwarded client', async () => {
      await switchOn({ mode: 'tailscale', secret: TS_KEY, publicUrl: TUNNEL });
      const lookup = (ip: string) =>
        viaTunnel(socketPath, 'GET', '/api/v1/join/whatever', {
          headers: { 'x-forwarded-for': ip },
        });
      for (let i = 0; i < 20; i++) expect((await lookup('203.0.113.20')).status).toBe(200);
      expect((await lookup('203.0.113.20')).status).toBe(429);
      expect((await lookup('10.0.0.1, 203.0.113.20')).status).toBe(429);
      expect((await lookup('203.0.113.21')).status).toBe(200);
    });

    it('marks cookies Secure on requests that came through the https tunnel', async () => {
      await switchOn({ mode: 'cloudflare', secret: TOKEN, publicUrl: TUNNEL });
      const through = await signIn('203.0.113.30', { 'x-forwarded-proto': 'https' });
      expect(through.status).toBe(200);
      expect(cookiesOf(through).length).toBeGreaterThan(0);
      for (const c of cookiesOf(through)) expect(c).toMatch(/;\s*Secure/i);

      const local = await http()
        .post('/api/auth/sign-in/email')
        .send({ email: 'owner@example.com', password: PASSWORD });
      for (const c of local.headers['set-cookie'] as unknown as string[]) {
        expect(c).not.toMatch(/;\s*Secure/i);
      }
    });

    it('does not believe X-Forwarded-Proto from loopback TCP while no tunnel runs', async () => {
      const res = await http()
        .post('/api/auth/sign-in/email')
        .set({ 'x-forwarded-proto': 'https' })
        .send({ email: 'admin@example.com', password: PASSWORD });
      expect(res.status).toBe(200);
      for (const c of res.headers['set-cookie'] as unknown as string[]) {
        expect(c).not.toMatch(/;\s*Secure/i);
      }
    });

    it('has no open sign-up through the tunnel once the first account exists', async () => {
      await switchOn({ mode: 'cloudflare', secret: TOKEN, publicUrl: TUNNEL });
      const headers = { origin: TUNNEL, 'x-forwarded-for': '203.0.113.40' };
      const signUp = await viaTunnel(socketPath, 'POST', '/api/auth/sign-up/email', {
        headers,
        body: { email: 'stranger@example.com', password: PASSWORD, name: 'Stranger' },
      });
      expect(signUp.status).toBe(403);
      const setup = await viaTunnel(socketPath, 'POST', '/api/v1/setup', {
        headers,
        body: {
          code: 'ABCD-EFGH',
          name: 'Stranger',
          email: 'stranger@example.com',
          password: PASSWORD,
          modules: [],
        },
      });
      expect(setup.status).toBe(410);
    });
  });

  it('never sent a stored secret in any response', () => {
    expect(seen.length).toBeGreaterThan(10);
    for (const text of seen) {
      expect(text).not.toContain(TOKEN);
      expect(text).not.toContain(TS_KEY);
    }
  });
});

describe('remote access at boot', () => {
  it('starts the stored tunnel again when the app restarts, and stops it on shutdown', async () => {
    const first = fakeSpawn(healthyTunnels);
    const t = await createTestApp({}, [], [], true, first.spawn);
    const { user } = await t.auth.api.createUser({
      body: { email: 'boot@example.com', password: PASSWORD, name: 'Boot' },
    });
    await makeInstallOwner(t, user.id);
    const signedIn = await t.auth.api.signInEmail({
      body: { email: 'boot@example.com', password: PASSWORD },
      asResponse: true,
    });
    const cookie = signedIn.headers
      .getSetCookie()
      .map((c) => c.split(';')[0])
      .join('; ');
    const res = await request(t.app.getHttpServer())
      .put(ENDPOINT)
      .set({ cookie })
      .send({ mode: 'cloudflare', secret: TOKEN, publicUrl: TUNNEL });
    expect(res.status).toBe(200);
    const child = first.last().child;
    await t.app.close();
    expect(child.signals).toContain('SIGTERM');

    const again = fakeSpawn(healthyTunnels);
    const second = await t.reopen(again.spawn);
    try {
      for (let i = 0; i < 10 && again.calls.length === 0; i++) await flush();
      expect(again.last().command).toBe('/usr/local/bin/cloudflared');
      expect(again.last().options.env.TUNNEL_TOKEN).toBe(TOKEN);
    } finally {
      await second.close();
    }
  });
});

describe('remote access when the tunnel socket cannot be opened', () => {
  it('reports an error, stops the tunnel and keeps serving TCP', async () => {
    const spawned = fakeSpawn(healthyTunnels);
    const t = await createTestApp({}, [], [], true, spawned.spawn);
    try {
      const { user } = await t.auth.api.createUser({
        body: { email: 'nosock@example.com', password: PASSWORD, name: 'No socket' },
      });
      await makeInstallOwner(t, user.id);
      const signedIn = await t.auth.api.signInEmail({
        body: { email: 'nosock@example.com', password: PASSWORD },
        asResponse: true,
      });
      const cookie = signedIn.headers
        .getSetCookie()
        .map((c) => c.split(';')[0])
        .join('; ');
      const http = () => request(t.app.getHttpServer());
      const body = { mode: 'cloudflare', secret: TOKEN, publicUrl: TUNNEL };
      expect((await http().put(ENDPOINT).set({ cookie }).send(body)).status).toBe(200);
      const child = spawned.last().child;

      await t.app.get(RemoteAccessService).tunnelSocketUnavailable('socket is gone');
      expect(child.signals).toContain('SIGTERM');
      const settings = await http().get(ENDPOINT).set({ cookie });
      expect(settings.body).toMatchObject({ status: 'error', lastError: 'socket is gone' });

      const calls = spawned.calls.length;
      const again = await http().put(ENDPOINT).set({ cookie }).send(body);
      expect(again.body).toMatchObject({ status: 'error', lastError: 'socket is gone' });
      expect(spawned.calls).toHaveLength(calls);
      expect((await http().get('/api/health')).status).toBe(200);
    } finally {
      await t.close();
    }
  });
});
