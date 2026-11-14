import {
  authSchema,
  inviteLinks,
  joinRequests,
  projectAccessChecklist,
  projectMembers,
  projects,
} from '@briefroom/db';
import { and, eq } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestApp, makeInstallOwner, resetThrottle, type TestApp } from './helpers.ts';

const PASSWORD = 'correct horse battery';
const GONE = '00000000-0000-4000-8000-000000000000';

describe('joining a workspace', () => {
  let t: TestApp;
  let ws: string;
  let ws2: string;
  let p1: string;
  let p2: string;
  const ids: Record<string, string> = {};
  const cookies: Record<string, string> = {};
  let counter = 0;

  const http = () => request(t.app.getHttpServer());
  const base = `/api/v1/workspaces`;
  const as = (who: string) => ({ cookie: cookies[who]! });
  const tokenOf = (url: string) => url.split('/join/')[1]!;
  const invite = async (body: object = {}, who = 'admin', w = ws) => {
    const res = await http().post(`${base}/${w}/invites`).set(as(who)).send(body);
    expect(res.status).toBe(201);
    return { id: res.body.id as string, token: tokenOf(res.body.url) };
  };
  const link = async (id: string) =>
    (await t.db.db.select().from(inviteLinks).where(eq(inviteLinks.id, id)))[0]!;
  const accept = (token: string, who: string) =>
    http().post(`/api/v1/join/${token}/accept`).set(as(who));
  const signUp = (token: string, body: Record<string, unknown>) =>
    http().post(`/api/v1/join/${token}/sign-up`).send(body);
  const cookiesOf = (res: { headers: Record<string, unknown> }) =>
    (res.headers['set-cookie'] ?? []) as string[];
  const newBody = (label = 'newbie') => {
    counter += 1;
    return {
      name: `${label} ${counter}`,
      email: `${label}${counter}@example.com`,
      password: PASSWORD,
    };
  };
  const roleOf = async (userId: string, w = ws) =>
    (
      await t.db.db
        .select()
        .from(authSchema.member)
        .where(and(eq(authSchema.member.userId, userId), eq(authSchema.member.organizationId, w)))
    )[0]?.role;
  const userByEmail = async (email: string) =>
    (await t.db.db.select().from(authSchema.user).where(eq(authSchema.user.email, email)))[0];
  const projectsOf = async (userId: string) =>
    (await t.db.db.select().from(projectMembers).where(eq(projectMembers.userId, userId)))
      .map((r) => r.projectId)
      .sort();
  const makeAccount = async (key: string) => {
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
  };
  const insertProject = async (w: string, name: string) =>
    (
      await t.db.db
        .insert(projects)
        .values({
          workspaceId: w,
          name,
          createdBy: ids.owner!,
          createdVia: 'system',
          updatedBy: ids.owner!,
          updatedVia: 'system',
        })
        .returning()
    )[0]!.id;

  beforeAll(async () => {
    t = await createTestApp();
    for (const key of ['owner', 'admin', 'member']) await makeAccount(key);
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
    await t.auth.api.addMember({ body: { userId: ids.admin!, role: 'admin', organizationId: ws } });
    await t.auth.api.addMember({
      body: { userId: ids.member!, role: 'member', organizationId: ws },
    });
    p1 = await insertProject(ws, 'One');
    p2 = await insertProject(ws, 'Two');
  });

  beforeEach(() => {
    resetThrottle(t);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await t.close();
  });

  it('signs up through a valid link, joins as member on the link projects and signs in', async () => {
    const gone = await insertProject(ws, 'Doomed');
    const { id, token } = await invite({ projectIds: [p1, p2, gone] });
    await t.db.db.delete(projects).where(eq(projects.id, gone));
    const body = newBody();
    const res = await signUp(token, body);
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ status: 'joined', workspaceId: ws });
    expect(cookiesOf(res).join(';')).toContain('session_token');
    const user = await userByEmail(body.email);
    expect(user).toBeDefined();
    expect(await roleOf(user!.id)).toBe('member');
    expect(await projectsOf(user!.id)).toEqual([p1, p2].sort());
    expect((await link(id)).uses).toBe(1);
    const me = await http()
      .get('/api/v1/workspaces')
      .set({
        cookie: cookiesOf(res)
          .map((c) => c.split(';')[0])
          .join('; '),
      });
    expect(me.status).toBe(200);
    expect(me.body.map((w: { id: string }) => w.id)).toContain(ws);
  });

  it('lets exactly one of two accounts take the last use of a link (Review Focus 3)', async () => {
    await makeAccount('racer1');
    await makeAccount('racer2');
    const { id, token } = await invite({ maxUses: 1 });
    const [a, b] = await Promise.all([accept(token, 'racer1'), accept(token, 'racer2')]);
    expect([a.status, b.status].sort()).toEqual([200, 410]);
    const loser = a.status === 410 ? a : b;
    expect(loser.body.code).toBe('invite_invalid');
    expect((await link(id)).uses).toBe(1);
    const roles = [await roleOf(ids.racer1!), await roleOf(ids.racer2!)];
    expect(roles.filter(Boolean)).toHaveLength(1);
  });

  it('accepts as a signed-in account and returns 410 once the link is used up', async () => {
    await makeAccount('acceptor');
    await makeAccount('latecomer');
    const { token } = await invite({ maxUses: 1, projectIds: [p1] });
    const ok = await accept(token, 'acceptor');
    expect(ok.body).toEqual({ status: 'joined', workspaceId: ws });
    expect(await roleOf(ids.acceptor!)).toBe('member');
    expect(await projectsOf(ids.acceptor!)).toEqual([p1]);
    const late = await accept(token, 'latecomer');
    expect(late.status).toBe(410);
    expect(await roleOf(ids.latecomer!)).toBeUndefined();
  });

  it('answers 410 for revoked and expired links', async () => {
    await makeAccount('stale');
    const revoked = await invite();
    await http().delete(`${base}/${ws}/invites/${revoked.id}`).set(as('admin'));
    const expired = await invite();
    await t.db.db
      .update(inviteLinks)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(inviteLinks.id, expired.id));
    for (const { token } of [revoked, expired, { token: 'x'.repeat(43) }]) {
      const res = await accept(token, 'stale');
      expect(res.status).toBe(410);
      expect(res.body.code).toBe('invite_invalid');
    }
  });

  it('refuses accept without a session', async () => {
    const { token } = await invite();
    expect((await http().post(`/api/v1/join/${token}/accept`)).status).toBe(401);
  });

  it('returns 409 already_member without consuming a use', async () => {
    const { id, token } = await invite({ maxUses: 5 });
    const res = await accept(token, 'member');
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('already_member');
    expect((await link(id)).uses).toBe(0);
  });

  it('holds an approval link as pending, then approve makes them a member on the projects', async () => {
    await makeAccount('wannabe');
    const { id, token } = await invite({ requiresApproval: true, projectIds: [p1, p2] });
    const res = await accept(token, 'wannabe');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'pending' });
    expect(await roleOf(ids.wannabe!)).toBeUndefined();
    expect((await link(id)).uses).toBe(1);

    const again = await accept(token, 'wannabe');
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('already_requested');
    expect((await link(id)).uses).toBe(1);

    const list = await http().get(`${base}/${ws}/join-requests`).set(as('admin'));
    expect(list.status).toBe(200);
    const mine = list.body.find((r: { userId: string }) => r.userId === ids.wannabe);
    expect(mine).toMatchObject({
      name: 'wannabe',
      email: 'wannabe@example.com',
      role: 'member',
      requestedAt: expect.any(String),
      emailVerified: false,
    });
    expect(Object.keys(mine).sort()).toEqual(
      ['email', 'emailVerified', 'id', 'name', 'requestedAt', 'role', 'userId'].sort(),
    );

    const ok = await http().post(`${base}/${ws}/join-requests/${mine.id}/approve`).set(as('admin'));
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ status: 'joined', workspaceId: ws });
    expect(await roleOf(ids.wannabe!)).toBe('member');
    expect(await projectsOf(ids.wannabe!)).toEqual([p1, p2].sort());
    const row = (await t.db.db.select().from(joinRequests).where(eq(joinRequests.id, mine.id)))[0];
    expect(row).toMatchObject({ status: 'approved', updatedBy: ids.admin });

    const repeat = await http()
      .post(`${base}/${ws}/join-requests/${mine.id}/approve`)
      .set(as('admin'));
    expect(repeat.status).toBe(404);
  });

  it('declines a request and leaves the account out', async () => {
    const body = newBody('declined');
    const { token } = await invite({ requiresApproval: true });
    expect((await signUp(token, body)).body).toEqual({ status: 'pending' });
    const user = (await userByEmail(body.email))!;
    const [req] = await t.db.db.select().from(joinRequests).where(eq(joinRequests.userId, user.id));
    const res = await http()
      .post(`${base}/${ws}/join-requests/${req!.id}/decline`)
      .set(as('admin'));
    expect(res.status).toBe(204);
    expect(await roleOf(user.id)).toBeUndefined();
    const list = await http().get(`${base}/${ws}/join-requests`).set(as('admin'));
    expect(list.body.map((r: { id: string }) => r.id)).not.toContain(req!.id);
    const again = await http()
      .post(`${base}/${ws}/join-requests/${req!.id}/decline`)
      .set(as('admin'));
    expect(again.status).toBe(404);
  });

  it('gives the admin role on approval of an admin invite (R87)', async () => {
    await makeAccount('future_admin');
    const { token } = await invite({ role: 'admin' });
    expect((await accept(token, 'future_admin')).body).toEqual({ status: 'pending' });
    const [req] = await t.db.db
      .select()
      .from(joinRequests)
      .where(eq(joinRequests.userId, ids.future_admin!));
    expect(req!.role).toBe('admin');
    const ok = await http().post(`${base}/${ws}/join-requests/${req!.id}/approve`).set(as('admin'));
    expect(ok.status).toBe(200);
    expect(await roleOf(ids.future_admin!)).toBe('admin');
  });

  it('marks a request approved and answers 409 when the user became a member meanwhile', async () => {
    await makeAccount('sneaky');
    const { token } = await invite({ requiresApproval: true });
    await accept(token, 'sneaky');
    await t.auth.api.addMember({
      body: { userId: ids.sneaky!, role: 'member', organizationId: ws },
    });
    const [req] = await t.db.db
      .select()
      .from(joinRequests)
      .where(eq(joinRequests.userId, ids.sneaky!));
    const res = await http()
      .post(`${base}/${ws}/join-requests/${req!.id}/approve`)
      .set(as('admin'));
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('already_member');
    expect(
      (await t.db.db.select().from(joinRequests).where(eq(joinRequests.id, req!.id)))[0]!.status,
    ).toBe('approved');
  });

  it('returns 409 account_exists for an existing email and creates no user', async () => {
    const { id, token } = await invite();
    const before = (await t.db.db.select().from(authSchema.user)).length;
    const res = await signUp(token, {
      name: 'Dup',
      email: 'Member@Example.com',
      password: PASSWORD,
    });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('account_exists');
    expect((await t.db.db.select().from(authSchema.user)).length).toBe(before);
    expect((await link(id)).uses).toBe(0);
  });

  it('returns 410 for an invalid token on sign-up and creates no account', async () => {
    const body = newBody('ghost');
    const before = (await t.db.db.select().from(authSchema.user)).length;
    const res = await signUp('y'.repeat(43), body);
    expect(res.status).toBe(410);
    expect(res.body.code).toBe('invite_invalid');
    expect(await userByEmail(body.email)).toBeUndefined();
    expect((await t.db.db.select().from(authSchema.user)).length).toBe(before);
  });

  it('validates the sign-up body', async () => {
    const { token } = await invite();
    const bad = [
      { ...newBody(), password: 'short' },
      { ...newBody(), name: '' },
      { ...newBody(), name: 'n'.repeat(81) },
      { ...newBody(), email: 'not-an-email' },
      {},
    ];
    for (const body of bad) expect((await signUp(token, body)).status).toBe(400);
  });

  it('leaves no user, member or use behind when joining fails after sign-up', async () => {
    const { id, token } = await invite({ projectIds: [p1] });
    vi.spyOn(t.auth.api, 'addMember').mockRejectedValueOnce(new Error('boom with secret@x.com'));
    const body = newBody('failing');
    const count = async () => [
      (await t.db.db.select().from(authSchema.session)).length,
      (await t.db.db.select().from(authSchema.member)).length,
      (await t.db.db.select().from(joinRequests)).length,
    ];
    const before = await count();
    const res = await signUp(token, body);
    expect(res.status).toBe(500);
    expect(await count()).toEqual(before);
    expect(JSON.stringify(res.body)).not.toContain('secret');
    expect(await userByEmail(body.email)).toBeUndefined();
    expect((await link(id)).uses).toBe(0);
  });

  it('rolls back the member and the use when the project step fails on accept', async () => {
    await makeAccount('halfway');
    const withLink = await http()
      .post(`${base}/${ws}/projects`)
      .set(as('admin'))
      .send({ name: 'Linked', toolLinks: [{ label: 'Wiki', url: 'https://wiki.example.com/x' }] });
    const { id, token } = await invite({ projectIds: [withLink.body.id, p1] });
    const { ProjectMembersService } = await import('../src/projects/project-members.service.ts');
    const real = ProjectMembersService.prototype.add;
    vi.spyOn(ProjectMembersService.prototype, 'add')
      .mockImplementationOnce(function (this: unknown, ...args) {
        return real.apply(this as never, args);
      })
      .mockRejectedValueOnce(new Error('boom'));
    const res = await accept(token, 'halfway');
    expect(res.status).toBe(500);
    expect(await roleOf(ids.halfway!)).toBeUndefined();
    expect(await projectsOf(ids.halfway!)).toEqual([]);
    expect(
      await t.db.db
        .select()
        .from(projectAccessChecklist)
        .where(eq(projectAccessChecklist.userId, ids.halfway!)),
    ).toEqual([]);
    expect((await link(id)).uses).toBe(0);
    const retry = await accept(token, 'halfway');
    expect(retry.body).toEqual({ status: 'joined', workspaceId: ws });
  });

  describe('join request routes', () => {
    const route = (suffix = '', w = ws) => `${base}/${w}/join-requests${suffix}`;

    it('refuses a member with 403', async () => {
      expect((await http().get(route()).set(as('member'))).status).toBe(403);
      expect(
        (
          await http()
            .post(route(`/${GONE}/approve`))
            .set(as('member'))
        ).status,
      ).toBe(403);
      expect(
        (
          await http()
            .post(route(`/${GONE}/decline`))
            .set(as('member'))
        ).status,
      ).toBe(403);
    });

    it('404s a malformed, unknown, foreign or non-pending id', async () => {
      await makeAccount('elsewhere');
      const other = await invite({ requiresApproval: true }, 'owner', ws2);
      await accept(other.token, 'elsewhere');
      const [foreign] = await t.db.db
        .select()
        .from(joinRequests)
        .where(eq(joinRequests.workspaceId, ws2));
      for (const action of ['approve', 'decline']) {
        for (const id of ['nope', GONE, foreign!.id]) {
          const res = await http()
            .post(route(`/${id}/${action}`))
            .set(as('admin'));
          expect(res.status).toBe(404);
        }
      }
      expect(
        (await t.db.db.select().from(joinRequests).where(eq(joinRequests.id, foreign!.id)))[0]!
          .status,
      ).toBe('pending');
      expect(await roleOf(ids.elsewhere!, ws2)).toBeUndefined();
    });
  });
});
