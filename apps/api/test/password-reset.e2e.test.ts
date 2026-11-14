import { ResetLinkResponse } from '@briefroom/contracts';
import { passwordResetLinks } from '@briefroom/db';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PasswordResetLinks } from '../src/members/password-reset-links.service.ts';
import { runResetPassword } from '../src/admin-cli.ts';
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
