import { createHash } from 'node:crypto';
import { authSchema, cliLogins } from '@briefroom/db';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, makeInstallOwner, resetThrottle, type TestApp } from './helpers.ts';

const PASSWORD = 'correct horse battery';
const CODE = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}$/;
const EXPIRED = { status: 'expired' };
const ACCEPT = 'application/json, text/event-stream';

interface Started {
  code: string;
  approveUrl: string;
  pollToken: string;
  expiresAt: string;
  interval: number;
}

describe('cli login', () => {
  let t: TestApp;
  let base: string;
  let ws: string;
  let other: string;
  const ids: Record<string, string> = {};
  const cookies: Record<string, string> = {};

  const http = () => request(t.app.getHttpServer());
  const as = (who: string) => ({ cookie: cookies[who]! });
  const rows = () => t.db.db.select().from(cliLogins);
  const sha = (v: string) => createHash('sha256').update(v).digest('hex');

  async function addUser(key: string, memberships: string[] = []) {
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
    for (const organizationId of memberships) {
      await t.auth.api.addMember({ body: { userId: user.id, role: 'member', organizationId } });
    }
  }

  const start = async (deviceName?: string): Promise<Started> => {
    const res = await http()
      .post('/api/v1/cli-login')
      .send(deviceName === undefined ? {} : { deviceName });
    expect(res.status).toBe(201);
    return res.body as Started;
  };
  const poll = (pollToken: string) => http().post('/api/v1/cli-login/poll').send({ pollToken });
  const approve = (who: string, code: string, workspaceId = ws) =>
    http().post('/api/v1/cli-login/approve').set(as(who)).send({ code, workspaceId });

  const mcp = (token: string) =>
    fetch(`${base}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: ACCEPT,
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });

  async function approvedToken(who = 'alice', deviceName?: string) {
    const s = await start(deviceName);
    expect((await approve(who, s.code)).status).toBe(200);
    const res = await poll(s.pollToken);
    expect(res.body.status).toBe('approved');
    return res.body as { token: string; workspaceId: string };
  }

  beforeAll(async () => {
    t = await createTestApp();
    await t.app.listen(0, '127.0.0.1');
    base = `http://127.0.0.1:${(t.app.getHttpServer().address() as { port: number }).port}`;
    await addUser('owner');
    await makeInstallOwner(t, ids.owner!);
    ws = (
      await t.auth.api.createOrganization({
        body: { name: 'Acme', slug: 'acme', userId: ids.owner! },
      })
    ).id;
    other = (
      await t.auth.api.createOrganization({
        body: { name: 'Other', slug: 'other', userId: ids.owner! },
      })
    ).id;
    await addUser('alice', [ws]);
    await addUser('bob', [ws]);
    await addUser('outsider');
  });

  afterAll(async () => {
    await t.close();
  });

  beforeEach(async () => {
    resetThrottle(t);
    await t.db.db.delete(cliLogins);
  });

  describe('start', () => {
    it('returns an XXXX-XXXX code from the unambiguous alphabet, an approve url and a poll token', async () => {
      const seen = new Set<string>();
      for (let i = 0; i < 8; i++) {
        const s = await start();
        expect(s.code).toMatch(CODE);
        seen.add(s.code);
        expect(s.approveUrl).toBe(`http://localhost:4300/connect?code=${s.code}`);
        expect(s.pollToken.length).toBeGreaterThanOrEqual(43);
        expect(s.interval).toBe(2);
      }
      expect(seen.size).toBe(8);
    });

    it('stores the code as is and the poll token only as a sha-256 hash, with audit columns', async () => {
      const s = await start('my laptop');
      const [row] = await rows();
      expect(row!.code).toBe(s.code);
      expect(row!.pollTokenHash).toBe(sha(s.pollToken));
      expect(JSON.stringify(row)).not.toContain(s.pollToken);
      expect(row).toMatchObject({
        status: 'pending',
        deviceName: 'my laptop',
        userId: null,
        workspaceId: null,
        tokenId: null,
        createdVia: 'cli',
        updatedVia: 'cli',
      });
      const ttl = row!.expiresAt.getTime() - row!.createdAt.getTime();
      expect(ttl).toBe(10 * 60 * 1000);
    });

    it('sanitises the device name and falls back to Briefroom CLI', async () => {
      const long = `a\u0000b\n${'x'.repeat(200)}`;
      await start(long);
      await start('   ');
      await start();
      const names = (await rows()).map((r) => r.deviceName);
      expect(names).toContain('Briefroom CLI');
      const sanitised = names.find((n) => n.startsWith('ab'))!;
      expect(sanitised).toMatch(/^abx+$/);
      expect(sanitised.length).toBe(80);
      expect(names.filter((n) => n === 'Briefroom CLI')).toHaveLength(2);
    });

    it('removes expired rows when a new login starts', async () => {
      const old = await start();
      await t.db.db
        .update(cliLogins)
        .set({ expiresAt: new Date(Date.now() - 1000) })
        .where(eq(cliLogins.code, old.code));
      const fresh = await start();
      expect((await rows()).map((r) => r.code)).toEqual([fresh.code]);
    });

    it('allows 10 starts a minute per client and then returns 429 rate_limited', async () => {
      for (let i = 0; i < 10; i++)
        expect((await http().post('/api/v1/cli-login').send({})).status).toBe(201);
      const res = await http().post('/api/v1/cli-login').send({});
      expect(res.status).toBe(429);
      expect(res.body.code).toBe('rate_limited');
    });
  });

  describe('flow', () => {
    it('answers pending, then the token once, then the same as expired', async () => {
      const s = await start('laptop');
      expect((await poll(s.pollToken)).body).toEqual({ status: 'pending' });

      const approved = await approve('alice', s.code);
      expect(approved.status).toBe(200);
      expect(approved.body.deviceName).toBe('laptop');
      expect(approved.body.workspaceName).toBe('Acme');
      expect(Number.isNaN(Date.parse(approved.body.startedAt))).toBe(false);
      expect(JSON.stringify(approved.body)).not.toMatch(/\d+\.\d+\.\d+\.\d+|::/);

      const first = await poll(s.pollToken);
      expect(first.status).toBe(200);
      expect(first.body).toMatchObject({
        status: 'approved',
        workspaceId: ws,
        workspaceName: 'Acme',
        baseUrl: 'http://localhost:4300',
      });
      expect(first.body.token).toMatch(/^brf_/);
      expect(typeof first.body.installId).toBe('string');

      const second = await poll(s.pollToken);
      expect(second.status).toBe(200);
      expect(second.body).toEqual(EXPIRED);
      expect(JSON.stringify(second.body)).not.toContain(first.body.token);
    });

    it('never keeps the plaintext token in the cli_logins row', async () => {
      const s = await start();
      await approve('alice', s.code);
      expect(JSON.stringify(await rows())).not.toContain('brf_');
      const { body } = await poll(s.pollToken);
      const all = JSON.stringify(await rows());
      expect(all).not.toContain(body.token);
      expect(all).not.toContain('brf_');
      const [row] = await rows();
      expect(row).toMatchObject({ status: 'consumed', userId: ids.alice, workspaceId: ws });
      expect(row!.tokenId).toBeTruthy();
    });

    it('creates the token through the tokens service, named after the CLI and owned by the approver', async () => {
      const { token } = await approvedToken('alice', 'work laptop');
      const keys = await t.db.db.select().from(authSchema.apikey);
      const key = keys.find((k) => k.name === 'CLI: work laptop')!;
      expect(key.referenceId).toBe(ids.alice);
      expect(token.startsWith('brf_')).toBe(true);
      const list = await http().get(`/api/v1/workspaces/${ws}/tokens`).set(as('alice'));
      expect(list.body.map((x: { name: string }) => x.name)).toContain('CLI: work laptop');
    });

    it('issues a token that works on /mcp', async () => {
      const { token } = await approvedToken();
      expect((await mcp(token)).status).toBe(200);
    });

    it('gives an identical response for expired, denied, consumed and unknown logins', async () => {
      const expired = await start();
      await t.db.db
        .update(cliLogins)
        .set({ expiresAt: new Date(Date.now() - 1000) })
        .where(eq(cliLogins.code, expired.code));
      const denied = await start();
      await t.db.db
        .update(cliLogins)
        .set({ status: 'denied' })
        .where(eq(cliLogins.code, denied.code));
      const consumed = await start();
      await approve('alice', consumed.code);
      await poll(consumed.pollToken);
      const approvedButExpired = await start();
      await approve('alice', approvedButExpired.code);
      await t.db.db
        .update(cliLogins)
        .set({ expiresAt: new Date(Date.now() - 1000) })
        .where(eq(cliLogins.code, approvedButExpired.code));

      const responses = await Promise.all(
        [
          expired.pollToken,
          denied.pollToken,
          consumed.pollToken,
          approvedButExpired.pollToken,
          'not-a-real-poll-token',
        ].map(poll),
      );
      for (const res of responses) {
        expect(res.status).toBe(200);
        expect(res.body).toEqual(EXPIRED);
      }
      expect(JSON.stringify(await rows())).not.toContain('brf_');
    });

    it('answers expired when the approver left the workspace before the poll, and makes no token', async () => {
      await addUser('leaver', [ws]);
      const s = await start();
      await approve('leaver', s.code);
      await t.db.db.delete(authSchema.member).where(eq(authSchema.member.userId, ids.leaver!));
      expect((await poll(s.pollToken)).body).toEqual(EXPIRED);
      const keys = await t.db.db.select().from(authSchema.apikey);
      expect(keys.filter((k) => k.referenceId === ids.leaver)).toHaveLength(0);
    });

    it('rejects a poll without a poll token with 400', async () => {
      expect((await http().post('/api/v1/cli-login/poll').send({})).status).toBe(400);
    });

    it('rate limits polling per client', async () => {
      const s = await start();
      for (let i = 0; i < 60; i++) expect((await poll(s.pollToken)).status).toBe(200);
      const res = await poll(s.pollToken);
      expect(res.status).toBe(429);
      expect(res.body.code).toBe('rate_limited');
    });
  });

  describe('approve', () => {
    it('needs a session', async () => {
      const s = await start();
      const res = await http()
        .post('/api/v1/cli-login/approve')
        .send({ code: s.code, workspaceId: ws });
      expect(res.status).toBe(401);
    });

    it('answers 404 to a non-member of the workspace, and leaves the login pending', async () => {
      const s = await start();
      expect((await approve('outsider', s.code)).status).toBe(404);
      expect((await approve('alice', s.code, other)).status).toBe(404);
      expect((await poll(s.pollToken)).body).toEqual({ status: 'pending' });
    });

    it('answers 404 to an unknown code and 400 to a malformed one', async () => {
      expect((await approve('alice', 'ABCD-EFGH')).status).toBe(404);
      expect((await approve('alice', 'nope')).status).toBe(400);
    });

    it('answers 410 to a code older than 10 minutes', async () => {
      const s = await start();
      await t.db.db
        .update(cliLogins)
        .set({ expiresAt: new Date(Date.now() - 1000) })
        .where(eq(cliLogins.code, s.code));
      expect((await approve('alice', s.code)).status).toBe(410);
    });

    it('is single use: a second approval fails and changes nothing', async () => {
      const s = await start();
      expect((await approve('alice', s.code)).status).toBe(200);
      const again = await approve('bob', s.code);
      expect(again.status).toBe(410);
      const [row] = await rows();
      expect(row!.userId).toBe(ids.alice);
    });

    it('is limited per user, against code guessing', async () => {
      for (let i = 0; i < 10; i++) expect((await approve('alice', 'ABCD-EFGH')).status).toBe(404);
      const res = await approve('alice', 'ABCD-EFGH');
      expect(res.status).toBe(429);
      expect(res.body.code).toBe('rate_limited');
      expect((await approve('bob', 'ABCD-EFGH')).status).toBe(404);
    });
  });

  describe('DELETE /api/v1/tokens/self', () => {
    it('deletes exactly the calling token and nothing else', async () => {
      const a = await approvedToken('alice');
      const b = await approvedToken('alice');
      const res = await fetch(`${base}/api/v1/tokens/self`, {
        method: 'DELETE',
        headers: { authorization: `Bearer ${a.token}` },
      });
      expect(res.status).toBe(204);
      expect((await mcp(a.token)).status).toBe(401);
      expect((await mcp(b.token)).status).toBe(200);
    });

    it('ignores a session cookie', async () => {
      const res = await http().delete('/api/v1/tokens/self').set(as('alice'));
      expect(res.status).toBe(401);
    });

    it('refuses a bad token the same way as /mcp and rate limits the refusals', async () => {
      const bad = () =>
        http().delete('/api/v1/tokens/self').set('authorization', 'Bearer brf_nope');
      const res = await bad();
      expect(res.status).toBe(401);
      expect(res.body).toEqual({ code: 'unauthorized', message: 'A valid token is required.' });
      for (let i = 0; i < 29; i++) await bad();
      expect((await bad()).status).toBe(429);
    });
  });
});
