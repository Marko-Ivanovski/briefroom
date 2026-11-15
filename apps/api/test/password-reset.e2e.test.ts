import { ResetLinkResponse } from '@briefroom/contracts';
import { authSchema, passwordResetLinks, type Db } from '@briefroom/db';
import { and, eq } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { DB } from '../src/database/database.module.ts';
import { PasswordResetLinks } from '../src/members/password-reset-links.service.ts';
import { runResetPassword } from '../src/admin-cli.ts';
import type { Scope } from '../src/access/scope.ts';
import { TokensService } from '../src/tokens/tokens.service.ts';
import { createTestApp, makeInstallOwner, type TestApp } from './helpers.ts';

const PASSWORD = 'correct horse battery';
const NEW_PASSWORD = 'a brand new passphrase';
const ROLES = ['owner', 'admin', 'admin2', 'member', 'bystander', 'other', 'outsider'] as const;

describe('password reset links', () => {
  let t: TestApp;
  let workspaceId: string;
  let otherWorkspaceId: string;
  const ids: Record<string, string> = {};
  const cookies: Record<string, string> = {};

  const http = () => request(t.app.getHttpServer());
  const as = (key: string) => ({ cookie: cookies[key]! });
  const linkPath = (userId: string, ws = workspaceId) =>
    `/api/v1/workspaces/${ws}/members/${userId}/reset-link`;
  const tokenOf = (url: string) => url.split('/reset/')[1]!;

  async function signIn(email: string, password: string): Promise<string> {
    const res = await t.auth.api.signInEmail({ body: { email, password }, asResponse: true });
    if (!res.ok) throw new Error(`sign-in failed ${res.status}`);
    return res.headers
      .getSetCookie()
      .map((c) => c.split(';')[0])
      .join('; ');
  }

  async function issue(caller: string, target: string): Promise<string> {
    const res = await http().post(linkPath(ids[target]!)).set(as(caller));
    expect(res.status).toBe(201);
    return ResetLinkResponse.parse(res.body).url;
  }

  async function newUser(key: string): Promise<string> {
    const { user } = await t.auth.api.createUser({
      body: { email: `${key}@example.com`, password: PASSWORD, name: key },
    });
    ids[key] = user.id;
    cookies[key] = await signIn(`${key}@example.com`, PASSWORD);
    return user.id;
  }

  async function join(key: string, role: 'admin' | 'member', ws = workspaceId): Promise<void> {
    if (!ids[key]) await newUser(key);
    await t.auth.api.addMember({ body: { userId: ids[key]!, role, organizationId: ws } });
  }

  const redeem = (url: string, password = NEW_PASSWORD) =>
    http()
      .post(`/api/v1/reset/${tokenOf(url)}`)
      .send({ password });

  beforeAll(async () => {
    t = await createTestApp();
    for (const key of ROLES) {
      const { user } = await t.auth.api.createUser({
        body: { email: `${key}@example.com`, password: PASSWORD, name: key },
      });
      ids[key] = user.id;
      cookies[key] = await signIn(`${key}@example.com`, PASSWORD);
    }
    await makeInstallOwner(t, ids.owner!);
    workspaceId = (
      await t.auth.api.createOrganization({
        body: { name: 'Acme', slug: 'acme', userId: ids.owner! },
      })
    ).id;
    otherWorkspaceId = (
      await t.auth.api.createOrganization({
        body: { name: 'Other', slug: 'other', userId: ids.owner! },
      })
    ).id;
    for (const [key, role] of [
      ['admin', 'admin'],
      ['admin2', 'admin'],
      ['member', 'member'],
      ['bystander', 'member'],
    ] as const) {
      await t.auth.api.addMember({
        body: { userId: ids[key]!, role, organizationId: workspaceId },
      });
    }
    await t.auth.api.addMember({
      body: { userId: ids.other!, role: 'member', organizationId: otherWorkspaceId },
    });
  });

  afterAll(async () => {
    await t.close();
  });

  it('lets an admin create a link for a member, who sets a password and signs in with it', async () => {
    const res = await http().post(linkPath(ids.member!)).set(as('admin'));
    expect(res.status).toBe(201);
    const { url, expiresAt } = ResetLinkResponse.parse(res.body);
    expect(url).toMatch(/^http:\/\/localhost:4300\/reset\/[A-Za-z0-9_-]{43}$/);
    const hours = (Date.parse(expiresAt) - Date.now()) / 3_600_000;
    expect(hours).toBeGreaterThan(23.9);
    expect(hours).toBeLessThanOrEqual(24);

    const [row] = await t.db.db
      .select()
      .from(passwordResetLinks)
      .where(eq(passwordResetLinks.userId, ids.member!));
    expect(row!.workspaceId).toBe(workspaceId);
    expect(row!.tokenHash).not.toContain(tokenOf(url));
    expect(row!.createdBy).toBe(ids.admin);

    const use = await http()
      .post(`/api/v1/reset/${tokenOf(url)}`)
      .send({ password: NEW_PASSWORD });
    expect(use.status).toBe(204);
    await expect(signIn('member@example.com', NEW_PASSWORD)).resolves.toBeTruthy();
    await expect(signIn('member@example.com', PASSWORD)).rejects.toThrow();
  });

  it('returns 410 when the same link is used a second time', async () => {
    const token = tokenOf(await issue('admin', 'member'));
    const first = await http().post(`/api/v1/reset/${token}`).send({ password: PASSWORD });
    expect(first.status).toBe(204);
    const second = await http().post(`/api/v1/reset/${token}`).send({ password: NEW_PASSWORD });
    expect(second.status).toBe(410);
    await expect(signIn('member@example.com', PASSWORD)).resolves.toBeTruthy();
  });

  it('returns 410 for a link older than 24 hours and for an unknown token', async () => {
    const token = tokenOf(await issue('admin', 'member'));
    await t.db.db
      .update(passwordResetLinks)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(passwordResetLinks.userId, ids.member!));
    const expired = await http().post(`/api/v1/reset/${token}`).send({ password: NEW_PASSWORD });
    expect(expired.status).toBe(410);
    const unknown = await http().post('/api/v1/reset/nope').send({ password: NEW_PASSWORD });
    expect(unknown.status).toBe(410);
  });

  it('hashes only after the token is known to be live (R57)', async () => {
    const ctx = await t.auth.$context;
    const hash = vi.spyOn(ctx.password, 'hash');
    try {
      const unknown = await http().post('/api/v1/reset/nope').send({ password: NEW_PASSWORD });
      expect(unknown.status).toBe(410);
      const token = tokenOf(await issue('admin', 'member'));
      await t.db.db
        .update(passwordResetLinks)
        .set({ expiresAt: new Date(Date.now() - 1000) })
        .where(eq(passwordResetLinks.userId, ids.member!));
      const expired = await http().post(`/api/v1/reset/${token}`).send({ password: NEW_PASSWORD });
      expect(expired.status).toBe(410);
      expect(hash).not.toHaveBeenCalled();

      const live = await issue('admin', 'member');
      expect((await redeem(live, PASSWORD)).status).toBe(204);
      expect(hash).toHaveBeenCalledTimes(1);
    } finally {
      hash.mockRestore();
    }
  });

  it('rejects a short password with 400 and leaves the link usable', async () => {
    const token = tokenOf(await issue('admin', 'member'));
    const short = await http().post(`/api/v1/reset/${token}`).send({ password: 'short' });
    expect(short.status).toBe(400);
    const ok = await http().post(`/api/v1/reset/${token}`).send({ password: PASSWORD });
    expect(ok.status).toBe(204);
  });

  it('revokes the user sessions when a link is used', async () => {
    const before = await signIn('member@example.com', PASSWORD);
    const probe = () => http().get('/api/v1/workspaces').set({ cookie: before });
    expect((await probe()).status).toBe(200);
    const token = tokenOf(await issue('admin', 'member'));
    const use = await http().post(`/api/v1/reset/${token}`).send({ password: NEW_PASSWORD });
    expect(use.status).toBe(204);
    expect((await probe()).status).toBe(401);
    const again = await signIn('member@example.com', NEW_PASSWORD);
    expect(again).toBeTruthy();
  });

  it('lets exactly one of two concurrent uses of a link succeed', async () => {
    const token = tokenOf(await issue('admin', 'member'));
    const results = await Promise.all(
      [PASSWORD, NEW_PASSWORD].map((password) =>
        http().post(`/api/v1/reset/${token}`).send({ password }),
      ),
    );
    expect(results.map((r) => r.status).sort()).toEqual([204, 410]);
  });

  describe('who may create a link', () => {
    it('refuses an admin creating a link for another admin with 403', async () => {
      const res = await http().post(linkPath(ids.admin2!)).set(as('admin'));
      expect(res.status).toBe(403);
    });

    it('refuses an admin creating a link for the owner with 403', async () => {
      const res = await http().post(linkPath(ids.owner!)).set(as('admin'));
      expect(res.status).toBe(403);
    });

    it('lets the install owner create a link for an admin', async () => {
      const res = await http().post(linkPath(ids.admin!)).set(as('owner'));
      expect(res.status).toBe(201);
    });

    it('refuses a member with 403', async () => {
      const res = await http().post(linkPath(ids.admin!)).set(as('bystander'));
      expect(res.status).toBe(403);
    });

    it('returns 400 when the caller targets themselves', async () => {
      const res = await http().post(linkPath(ids.admin!)).set(as('admin'));
      expect(res.status).toBe(400);
    });

    it('returns 404 for a user who is not a member of that workspace', async () => {
      const res = await http().post(linkPath(ids.other!)).set(as('admin'));
      expect(res.status).toBe(404);
      const none = await http().post(linkPath('no-such-user')).set(as('admin'));
      expect(none.status).toBe(404);
    });

    it('returns 404 to a non-member of the workspace and 401 without a session', async () => {
      expect((await http().post(linkPath(ids.member!)).set(as('outsider'))).status).toBe(404);
      expect((await http().post(linkPath(ids.member!))).status).toBe(401);
    });
  });

  describe('install-wide authorization (R46)', () => {
    it('refuses a link for a user who is member here but admin in another workspace', async () => {
      await join('dual', 'member');
      await join('dual', 'admin', otherWorkspaceId);
      const res = await http().post(linkPath(ids.dual!)).set(as('admin'));
      expect(res.status).toBe(403);
    });

    it('refuses a link when the target also belongs to a workspace the caller does not administer', async () => {
      const third = (
        await t.auth.api.createOrganization({
          body: { name: 'Third', slug: 'third', userId: ids.owner! },
        })
      ).id;
      await join('multi', 'member');
      await join('multi', 'member', third);
      const res = await http().post(linkPath(ids.multi!)).set(as('admin'));
      expect(res.status).toBe(403);
      const byOwner = await http().post(linkPath(ids.multi!)).set(as('owner'));
      expect(byOwner.status).toBe(201);
    });

    it('allows a member who belongs only to this workspace', async () => {
      await join('solo', 'member');
      expect((await http().post(linkPath(ids.solo!)).set(as('admin'))).status).toBe(201);
    });
  });

  describe('authorization at redeem (R48)', () => {
    it('returns 410 after the owner promotes the target to admin', async () => {
      await join('promoted', 'member');
      const url = await issue('admin', 'promoted');
      const res = await http()
        .patch(`/api/v1/workspaces/${workspaceId}/members/${ids.promoted}`)
        .set(as('owner'))
        .send({ role: 'admin' });
      expect(res.status).toBe(200);
      expect((await redeem(url)).status).toBe(410);
    });

    it('invalidates outstanding links when the role changes', async () => {
      await join('rolechg', 'member');
      const url = await issue('admin', 'rolechg');
      await http()
        .patch(`/api/v1/workspaces/${workspaceId}/members/${ids.rolechg}`)
        .set(as('admin'))
        .send({ role: 'admin' });
      const [row] = await t.db.db
        .select()
        .from(passwordResetLinks)
        .where(eq(passwordResetLinks.userId, ids.rolechg!));
      expect(row!.usedAt).not.toBeNull();
      expect((await redeem(url)).status).toBe(410);
    });

    it('re-checks the target role at use time even if the invalidation was bypassed', async () => {
      await join('bypass', 'member');
      const url = await issue('admin', 'bypass');
      await t.db.db
        .update(authSchema.member)
        .set({ role: 'admin' })
        .where(eq(authSchema.member.userId, ids.bypass!));
      expect((await redeem(url)).status).toBe(410);
      await expect(signIn('bypass@example.com', PASSWORD)).resolves.toBeTruthy();
    });

    it('returns 410 when the issuing admin was demoted before use', async () => {
      await join('issuer1', 'admin');
      await join('t1', 'member');
      const url = await issue('issuer1', 't1');
      await t.db.db
        .update(authSchema.member)
        .set({ role: 'member' })
        .where(eq(authSchema.member.userId, ids.issuer1!));
      expect((await redeem(url)).status).toBe(410);
    });

    it('returns 410 when the issuing admin was removed before use', async () => {
      await join('issuer2', 'admin');
      await join('t2', 'member');
      const url = await issue('issuer2', 't2');
      await t.db.db.delete(authSchema.member).where(eq(authSchema.member.userId, ids.issuer2!));
      expect((await redeem(url)).status).toBe(410);
    });

    it('still honours a link issued by the install owner for an admin', async () => {
      await join('adm5', 'admin');
      const url = await issue('owner', 'adm5');
      expect((await redeem(url)).status).toBe(204);
    });
  });

  describe('redeem failure handling', () => {
    const linkRow = async (userKey: string) =>
      (
        await t.db.db
          .select()
          .from(passwordResetLinks)
          .where(eq(passwordResetLinks.userId, ids[userKey]!))
      )[0]!;

    it('leaves the password and link untouched when the first session revoke fails', async () => {
      await join('rev1', 'member');
      const url = await issue('admin', 'rev1');
      const ctx = await t.auth.$context;
      vi.spyOn(ctx.internalAdapter, 'deleteUserSessions').mockRejectedValueOnce(new Error('boom'));
      const res = await redeem(url);
      expect(res.status).toBe(500);
      expect(JSON.stringify(res.body)).not.toContain('boom');
      await expect(signIn('rev1@example.com', PASSWORD)).resolves.toBeTruthy();
      expect((await linkRow('rev1')).usedAt).toBeNull();
      vi.restoreAllMocks();
      expect((await redeem(url)).status).toBe(204);
    });

    it('keeps the link used when the second session revoke fails after the password was set', async () => {
      await join('rev2', 'member');
      const url = await issue('admin', 'rev2');
      const ctx = await t.auth.$context;
      const spy = vi.spyOn(ctx.internalAdapter, 'deleteUserSessions');
      spy.mockImplementationOnce(() => Promise.resolve(undefined as never));
      spy.mockRejectedValueOnce(new Error('boom'));
      const res = await redeem(url);
      expect(res.status).toBe(500);
      expect(JSON.stringify(res.body)).not.toContain('boom');
      expect(spy).toHaveBeenCalledTimes(2);
      await expect(signIn('rev2@example.com', NEW_PASSWORD)).resolves.toBeTruthy();
      expect((await redeem(url, PASSWORD)).status).toBe(410);
      vi.restoreAllMocks();
    });

    it('keeps the link used and still revokes when the second token cutoff fails (S2)', async () => {
      await join('rev4', 'member');
      const url = await issue('admin', 'rev4');
      const tokens = t.app.get(TokensService);
      const scope = { userId: ids.rev4!, workspaceId } as Scope;
      const early = await tokens.create(scope, 'early');
      const ctx = await t.auth.$context;
      const original = ctx.internalAdapter.updatePassword.bind(ctx.internalAdapter);
      let gapCookie = '';
      let gapToken = '';
      vi.spyOn(ctx.internalAdapter, 'updatePassword').mockImplementationOnce(async (...args) => {
        gapCookie = await signIn('rev4@example.com', PASSWORD);
        gapToken = (await tokens.create(scope, 'gap')).token;
        return original(...args);
      });
      const cutoff = tokens.invalidateAll.bind(tokens);
      let calls = 0;
      vi.spyOn(tokens, 'invalidateAll').mockImplementation(async (userId) => {
        calls += 1;
        if (calls === 2) throw new Error('cutoff boom');
        return cutoff(userId);
      });
      const res = await redeem(url);
      vi.restoreAllMocks();
      expect(res.status).toBe(500);
      expect(JSON.stringify(res.body)).not.toContain('boom');
      expect(calls).toBe(2);
      await expect(signIn('rev4@example.com', NEW_PASSWORD)).resolves.toBeTruthy();
      expect((await http().get('/api/v1/workspaces').set({ cookie: gapCookie })).status).toBe(401);
      expect(await tokens.verify(early.token)).toBeNull();
      expect(await tokens.verify(gapToken)).toBeNull();
      expect((await linkRow('rev4')).usedAt).not.toBeNull();
      expect((await redeem(url, PASSWORD)).status).toBe(410);
    });

    it('still revokes sessions when expiring the other links fails', async () => {
      await join('rev3', 'member');
      const url = await issue('admin', 'rev3');
      const before = await signIn('rev3@example.com', PASSWORD);
      const probe = () => http().get('/api/v1/workspaces').set({ cookie: before });
      expect((await probe()).status).toBe(200);
      const db = t.app.get<Db>(DB);
      const original = db.update.bind(db);
      let calls = 0;
      vi.spyOn(db, 'update').mockImplementation(((table: never) => {
        if (++calls === 2) throw new Error('boom');
        return original(table);
      }) as typeof db.update);
      const res = await redeem(url);
      vi.restoreAllMocks();
      expect(res.status).toBe(500);
      expect((await probe()).status).toBe(401);
    });

    it('fails with 500 and un-claims the link when the user has no credential account', async () => {
      await join('nocred', 'member');
      const url = await issue('admin', 'nocred');
      await t.db.db
        .delete(authSchema.account)
        .where(
          and(
            eq(authSchema.account.userId, ids.nocred!),
            eq(authSchema.account.providerId, 'credential'),
          ),
        );
      const res = await redeem(url);
      expect(res.status).toBe(500);
      const [row] = await t.db.db
        .select()
        .from(passwordResetLinks)
        .where(eq(passwordResetLinks.userId, ids.nocred!));
      expect(row!.usedAt).toBeNull();
    });

    it('expires the other outstanding links for the user after a successful use', async () => {
      await join('older', 'member');
      const first = await issue('admin', 'older');
      const second = await issue('admin', 'older');
      expect((await redeem(second)).status).toBe(204);
      expect((await redeem(first)).status).toBe(410);
    });
  });

  describe('host reset command', () => {
    it('prints an install-level link that resets the install owner password', async () => {
      const links = t.app.get(PasswordResetLinks);
      const out = await runResetPassword(links, 'Owner@Example.com');
      expect(out.exitCode).toBe(0);
      expect(out.stdout).toMatch(/^http:\/\/localhost:4300\/reset\/[A-Za-z0-9_-]{43}$/);
      const [row] = await t.db.db
        .select()
        .from(passwordResetLinks)
        .where(eq(passwordResetLinks.userId, ids.owner!));
      expect(row!.workspaceId).toBeNull();
      expect(row!.createdVia).toBe('cli');

      const use = await http()
        .post(`/api/v1/reset/${tokenOf(out.stdout)}`)
        .send({ password: NEW_PASSWORD });
      expect(use.status).toBe(204);
      await expect(signIn('owner@example.com', NEW_PASSWORD)).resolves.toBeTruthy();
    });

    it('exits 1 with a message for an unknown email', async () => {
      const out = await runResetPassword(t.app.get(PasswordResetLinks), 'ghost@example.com');
      expect(out).toEqual({ exitCode: 1, stdout: '', stderr: 'No account with that email.' });
    });
  });
});
