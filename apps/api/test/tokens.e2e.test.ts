import { authSchema } from '@briefroom/db';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Scope } from '../src/access/scope.ts';
import { TokensService } from '../src/tokens/tokens.service.ts';
import { createTestApp, makeInstallOwner, type TestApp } from './helpers.ts';

const PASSWORD = 'correct horse battery';
const NEW_PASSWORD = 'another long passphrase';

describe('workspace tokens', () => {
  let t: TestApp;
  let ws: string;
  let ws2: string;
  const ids: Record<string, string> = {};
  const cookies: Record<string, string> = {};

  const http = () => request(t.app.getHttpServer());
  const as = (who: string) => ({ cookie: cookies[who]! });
  const path = (w = ws) => `/api/v1/workspaces/${w}/tokens`;
  const tokens = () => t.app.get(TokensService);
  const mint = async (who: string, w = ws, name = 'laptop') => {
    const res = await http().post(path(w)).set(as(who)).send({ name });
    expect(res.status).toBe(201);
    return res.body as { id: string; name: string; token: string };
  };

  async function addUser(key: string, memberships: { ws: string; role: 'admin' | 'member' }[]) {
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
    for (const m of memberships) {
      await t.auth.api.addMember({
        body: { userId: user.id, role: m.role, organizationId: m.ws },
      });
    }
  }

  beforeAll(async () => {
    t = await createTestApp();
    await addUser('owner', []);
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
    await addUser('alice', [
      { ws, role: 'member' },
      { ws: ws2, role: 'member' },
    ]);
    await addUser('bob', [{ ws, role: 'member' }]);
    await addUser('carol', [{ ws, role: 'member' }]);
    await addUser('dave', [{ ws, role: 'member' }]);
    await addUser('erin', [
      { ws, role: 'member' },
      { ws: ws2, role: 'member' },
    ]);
    await addUser('frank', [{ ws, role: 'member' }]);
    await addUser('outsider', []);
  });

  afterAll(async () => {
    await t.close();
  });

  it('verifies a created token to the same user and workspace', async () => {
    const { id, token } = await mint('alice');
    expect(token).toMatch(/^brf_/);
    expect(await tokens().verify(token)).toEqual({
      userId: ids.alice,
      workspaceId: ws,
      tokenId: id,
    });
  });

  it('stores only a hash of the token and sets no expiry', async () => {
    const { id, token } = await mint('alice');
    const [row] = await t.db.db
      .select()
      .from(authSchema.apikey)
      .where(eq(authSchema.apikey.id, id));
    expect(row!.key).not.toContain(token);
    expect(row!.expiresAt).toBeNull();
  });

  it('keeps working past Better Auth’s default rate limit', async () => {
    const { token } = await mint('alice');
    for (let i = 0; i < 15; i++) expect(await tokens().verify(token)).not.toBeNull();
  });

  it('lists only the caller’s own tokens in that workspace, never the key', async () => {
    const mine = await mint('bob', ws, 'mine');
    const theirs = await mint('carol', ws, 'theirs');
    const elsewhere = await mint('alice', ws2, 'other workspace');
    const res = await http().get(path()).set(as('bob'));
    expect(res.status).toBe(200);
    const body = res.body as { id: string }[];
    expect(body.map((r) => r.id)).toEqual([mine.id]);
    expect(Object.keys(body[0]!).sort()).toEqual(['createdAt', 'id', 'lastUsedAt', 'name']);
    const raw = JSON.stringify(res.body);
    for (const secret of [mine.token, theirs.token, elsewhere.token]) {
      expect(raw).not.toContain(secret);
    }
    expect(raw).not.toContain('brf_');
    const other = (await http().get(path(ws2)).set(as('alice'))).body as { id: string }[];
    expect(other.map((r) => r.id)).toContain(elsewhere.id);
    expect(other.map((r) => r.id)).not.toContain(mine.id);
  });

  it('reports last use once the token has been verified', async () => {
    const { id, token } = await mint('dave', ws, 'used');
    await tokens().verify(token);
    const res = await http().get(path()).set(as('dave'));
    const row = (res.body as { id: string; lastUsedAt: string | null }[]).find((r) => r.id === id)!;
    expect(row.lastUsedAt).not.toBeNull();
  });

  it('refuses a token after DELETE', async () => {
    const { id, token } = await mint('alice');
    expect((await http().delete(`${path()}/${id}`).set(as('alice'))).status).toBe(204);
    expect(await tokens().verify(token)).toBeNull();
    expect((await http().delete(`${path()}/${id}`).set(as('alice'))).status).toBe(404);
  });

  it('gives 404 for another user’s token, another workspace’s token and a malformed id', async () => {
    const { id, token } = await mint('bob', ws, 'bobs');
    const inWs2 = await mint('alice', ws2, 'alices');
    expect((await http().delete(`${path()}/${id}`).set(as('carol'))).status).toBe(404);
    expect(
      (
        await http()
          .delete(`${path(ws2)}/${inWs2.id}`)
          .set(as('erin'))
      ).status,
    ).toBe(404);
    expect(
      (
        await http()
          .delete(`${path(ws)}/${inWs2.id}`)
          .set(as('alice'))
      ).status,
    ).toBe(404);
    for (const bad of ['nope', '%00', '..%2F..', 'a'.repeat(100)]) {
      const res = await http().delete(`${path()}/${bad}`).set(as('bob'));
      expect([bad.slice(0, 8), res.status]).toEqual([bad.slice(0, 8), 404]);
    }
    expect(await tokens().verify(token)).not.toBeNull();
    expect(await tokens().verify(inWs2.token)).not.toBeNull();
  });

  it('validates the name as 1 to 80 trimmed characters', async () => {
    for (const name of ['', '   ', 'x'.repeat(81), 5, undefined]) {
      const res = await http().post(path()).set(as('bob')).send({ name });
      expect(res.status).toBe(400);
    }
    const ok = await http()
      .post(path())
      .set(as('bob'))
      .send({ name: `  ${'y'.repeat(80)}  ` });
    expect(ok.status).toBe(201);
    expect(ok.body.name).toBe('y'.repeat(80));
  });

  it('answers 404 to a non-member', async () => {
    expect((await http().get(path()).set(as('outsider'))).status).toBe(404);
    expect((await http().post(path()).set(as('outsider')).send({ name: 'x' })).status).toBe(404);
  });

  it('verifies to null for a key with no workspace id or an unknown key', async () => {
    const bare = await t.auth.api.createApiKey({ body: { userId: ids.bob!, name: 'bare' } });
    expect(await tokens().verify(bare.key)).toBeNull();
    expect(await tokens().verify('brf_unknown')).toBeNull();
    expect(await tokens().verify('')).toBeNull();
  });

  it('verifies to null once the user is no longer a member, without a handler running', async () => {
    const { token } = await mint('bob');
    await t.db.db.delete(authSchema.member).where(eq(authSchema.member.userId, ids.bob!));
    expect(await tokens().verify(token)).toBeNull();
    await t.auth.api.addMember({ body: { userId: ids.bob!, role: 'member', organizationId: ws } });
  });

  it('revokes the tokens of a removed member in that workspace only', async () => {
    const inWs = await mint('erin', ws);
    const inWs2 = await mint('erin', ws2);
    const res = await http()
      .delete(`/api/v1/workspaces/${ws}/members/${ids.erin}`)
      .set(as('owner'));
    expect(res.status).toBe(200);
    expect(await tokens().verify(inWs.token)).toBeNull();
    expect(await tokens().verify(inWs2.token)).not.toBeNull();
    const rows = await t.db.db
      .select()
      .from(authSchema.apikey)
      .where(eq(authSchema.apikey.id, inWs.id));
    expect(rows).toHaveLength(0);
  });

  it('revokes the tokens of a member who leaves', async () => {
    const { token } = await mint('carol');
    const res = await http().post(`/api/v1/workspaces/${ws}/leave`).set(as('carol'));
    expect(res.status).toBe(204);
    expect(await tokens().verify(token)).toBeNull();
  });

  it('revokes all of a user’s tokens when a reset link is redeemed (R145)', async () => {
    const a = await mint('alice', ws);
    const b = await mint('alice', ws2);
    const link = await http()
      .post(`/api/v1/workspaces/${ws}/members/${ids.alice}/reset-link`)
      .set(as('owner'));
    expect(link.status).toBe(201);
    const resetToken = (link.body.url as string).split('/reset/')[1]!;
    expect((await tokens().verify(a.token))?.userId).toBe(ids.alice);
    const res = await http().post(`/api/v1/reset/${resetToken}`).send({ password: NEW_PASSWORD });
    expect(res.status).toBe(204);
    expect(await tokens().verify(a.token)).toBeNull();
    expect(await tokens().verify(b.token)).toBeNull();
  });

  it('keeps tokens after a web sign-out (R149)', async () => {
    const { id, token } = await mint('frank');
    const res = await http().post('/api/auth/sign-out').set(as('frank'));
    expect(res.status).toBe(200);
    expect(await tokens().verify(token)).toEqual({
      userId: ids.frank,
      workspaceId: ws,
      tokenId: id,
    });
  });

  it('fails closed on a reset when the token cleanup throws (R151)', async () => {
    const { token } = await tokens().create(
      { userId: ids.frank!, workspaceId: ws } as Scope,
      'before',
    );
    const link = await http()
      .post(`/api/v1/workspaces/${ws}/members/${ids.frank}/reset-link`)
      .set(as('owner'));
    expect(link.status).toBe(201);
    const resetToken = (link.body.url as string).split('/reset/')[1]!;
    const spy = vi
      .spyOn(tokens() as unknown as { revokeFor(): Promise<void> }, 'revokeFor')
      .mockRejectedValue(new Error('cleanup failed'));
    try {
      const res = await http().post(`/api/v1/reset/${resetToken}`).send({ password: NEW_PASSWORD });
      expect(res.status).toBe(204);
      expect(spy).toHaveBeenCalled();
      expect(await tokens().verify(token)).toBeNull();
    } finally {
      spy.mockRestore();
    }
    const fresh = await tokens().create({ userId: ids.frank!, workspaceId: ws } as Scope, 'after');
    expect(await tokens().verify(fresh.token)).not.toBeNull();
  });

  describe('rejoin and reset races', () => {
    const scopeOf = (key: string, w = ws) => ({ userId: ids[key]!, workspaceId: w }) as Scope;
    const resetTokenFor = async (key: string) => {
      const link = await http()
        .post(`/api/v1/workspaces/${ws}/members/${ids[key]}/reset-link`)
        .set(as('owner'));
      expect(link.status).toBe(201);
      return (link.body.url as string).split('/reset/')[1]!;
    };
    const redeem = (resetToken: string) =>
      http().post(`/api/v1/reset/${resetToken}`).send({ password: NEW_PASSWORD });

    it('does not revive a token on rejoin when the cleanup failed (I1)', async () => {
      await addUser('gina', [{ ws, role: 'member' }]);
      const { token } = await mint('gina');
      const spy = vi
        .spyOn(tokens() as unknown as { revokeFor(): Promise<void> }, 'revokeFor')
        .mockRejectedValue(new Error('cleanup failed'));
      try {
        const res = await http()
          .delete(`/api/v1/workspaces/${ws}/members/${ids.gina}`)
          .set(as('owner'));
        expect(res.status).toBe(200);
      } finally {
        spy.mockRestore();
      }
      expect(await tokens().verify(token)).toBeNull();
      await t.auth.api.addMember({
        body: { userId: ids.gina!, role: 'member', organizationId: ws },
      });
      expect(await tokens().verify(token)).toBeNull();
      const fresh = await tokens().create(scopeOf('gina'), 'after rejoin');
      expect(await tokens().verify(fresh.token)).not.toBeNull();
    });

    it('keeps a token across a role change (I1)', async () => {
      await addUser('rob', [{ ws, role: 'member' }]);
      const { token } = await mint('rob');
      const res = await http()
        .patch(`/api/v1/workspaces/${ws}/members/${ids.rob}`)
        .set(as('owner'))
        .send({ role: 'admin' });
      expect(res.status).toBe(200);
      expect(await tokens().verify(token)).not.toBeNull();
    });

    it('refuses a create whose session ended mid-flight and leaves no key (I2)', async () => {
      await addUser('hank', [{ ws, role: 'member' }]);
      const original = t.auth.api.createApiKey.bind(t.auth.api);
      const spy = vi.spyOn(t.auth.api, 'createApiKey').mockImplementationOnce(async (...args) => {
        await t.db.db.delete(authSchema.session).where(eq(authSchema.session.userId, ids.hank!));
        return original(...args);
      });
      try {
        const res = await http().post(path()).set(as('hank')).send({ name: 'racy' });
        expect(res.status).toBe(401);
        expect(spy).toHaveBeenCalled();
      } finally {
        spy.mockRestore();
      }
      const rows = await t.db.db
        .select()
        .from(authSchema.apikey)
        .where(eq(authSchema.apikey.referenceId, ids.hank!));
      expect(rows).toHaveLength(0);
    });

    it('refuses a token minted between the cutoff and the password write (S1)', async () => {
      await addUser('ivy', [{ ws, role: 'member' }]);
      const resetToken = await resetTokenFor('ivy');
      const ctx = await t.auth.$context;
      const original = ctx.internalAdapter.updatePassword.bind(ctx.internalAdapter);
      let mid: { token: string } | undefined;
      const spy = vi
        .spyOn(ctx.internalAdapter, 'updatePassword')
        .mockImplementationOnce(async (...args) => {
          mid = await tokens().create(scopeOf('ivy'), 'mid');
          return original(...args);
        });
      const cleanup = vi
        .spyOn(tokens() as unknown as { revokeFor(): Promise<void> }, 'revokeFor')
        .mockRejectedValue(new Error('cleanup failed'));
      try {
        expect((await redeem(resetToken)).status).toBe(204);
      } finally {
        spy.mockRestore();
        cleanup.mockRestore();
      }
      expect(mid).toBeDefined();
      expect(await tokens().verify(mid!.token)).toBeNull();
    });

    it('fails the reset when the second cutoff write fails (S1)', async () => {
      await addUser('jo', [{ ws, role: 'member' }]);
      const resetToken = await resetTokenFor('jo');
      const service = tokens();
      const original = service.invalidateAll.bind(service);
      let calls = 0;
      const spy = vi.spyOn(service, 'invalidateAll').mockImplementation(async (userId) => {
        calls += 1;
        if (calls === 2) throw new Error('cutoff write failed');
        return original(userId);
      });
      try {
        expect((await redeem(resetToken)).status).toBe(500);
        expect(calls).toBe(2);
      } finally {
        spy.mockRestore();
      }
      expect((await redeem(resetToken)).status).toBe(204);
    });
  });

  it('keeps Better Auth’s api-key endpoints closed over HTTP', async () => {
    const { token } = await mint('dave');
    const calls = [
      http().post('/api/auth/api-key/create').set(as('dave')).send({ name: 'sneaky' }),
      http().get('/api/auth/api-key/list').set(as('dave')),
      http().post('/api/auth/api-key/verify').send({ key: token }),
      http().post('/api/auth/api-key/delete').set(as('dave')).send({ keyId: 'x' }),
    ];
    for (const res of await Promise.all(calls)) expect([403, 404]).toContain(res.status);
    expect(await tokens().verify(token)).not.toBeNull();
  });

  it('does not accept a token as a login on the API', async () => {
    const { token } = await mint('dave');
    const res = await http().get(path()).set({ 'x-api-key': token });
    expect(res.status).toBe(401);
  });
});
