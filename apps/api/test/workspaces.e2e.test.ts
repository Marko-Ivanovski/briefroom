import { MeResponse, MemberSummary, WorkspaceSummary } from '@briefroom/contracts';
import { authSchema } from '@briefroom/db';
import { and, eq } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, makeInstallOwner, type TestApp } from './helpers.ts';

const PASSWORD = 'correct horse battery';

describe('workspaces, scope and roles', () => {
  let t: TestApp;
  const ids: Record<string, string> = {};
  const cookies: Record<string, string> = {};
  let workspaceId: string;
  let otherWorkspaceId: string;

  const http = () => request(t.app.getHttpServer());
  const as = (who: string) => ({ cookie: cookies[who]! });

  async function newUser(key: string): Promise<void> {
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

  const roleOf = async (userId: string) => {
    const [row] = await t.db.db
      .select({ role: authSchema.member.role })
      .from(authSchema.member)
      .where(
        and(
          eq(authSchema.member.userId, userId),
          eq(authSchema.member.organizationId, workspaceId),
        ),
      );
    return row?.role;
  };

  beforeAll(async () => {
    t = await createTestApp();
    for (const key of ['owner', 'admin', 'member', 'outsider']) await newUser(key);
    await makeInstallOwner(t, ids.owner!);
    const ws = await t.auth.api.createOrganization({
      body: { name: 'Acme', slug: 'acme', userId: ids.owner! },
    });
    workspaceId = ws.id;
    const other = await t.auth.api.createOrganization({
      body: { name: 'Other', slug: 'other', userId: ids.owner! },
    });
    otherWorkspaceId = other.id;
    await t.auth.api.addMember({
      body: { userId: ids.admin!, role: 'admin', organizationId: workspaceId },
    });
    await t.auth.api.addMember({
      body: { userId: ids.member!, role: 'member', organizationId: workspaceId },
    });
  });

  afterAll(async () => {
    await t.close();
  });

  describe('GET /api/v1/me', () => {
    it('says whether the caller is the install owner', async () => {
      const owner = await http().get('/api/v1/me').set(as('owner'));
      expect(MeResponse.parse(owner.body)).toEqual({
        userId: ids.owner,
        name: 'owner',
        email: 'owner@example.com',
        isInstallOwner: true,
      });
      const admin = await http().get('/api/v1/me').set(as('admin'));
      expect(MeResponse.parse(admin.body).isInstallOwner).toBe(false);
    });

    it('requires a session', async () => {
      expect((await http().get('/api/v1/me')).status).toBe(401);
    });
  });

  describe('GET /api/v1/workspaces', () => {
    it('lists the workspaces the user belongs to with their role', async () => {
      const res = await http().get('/api/v1/workspaces').set(as('member'));
      expect(res.status).toBe(200);
      const list = WorkspaceSummary.array().parse(res.body);
      expect(list).toEqual([{ id: workspaceId, name: 'Acme', role: 'member' }]);
    });

    it('lists every workspace for the owner and none for a user with no membership', async () => {
      const owner = await http().get('/api/v1/workspaces').set(as('owner'));
      expect(
        WorkspaceSummary.array()
          .parse(owner.body)
          .map((w) => w.id)
          .sort(),
      ).toEqual([workspaceId, otherWorkspaceId].sort());
      const outsider = await http().get('/api/v1/workspaces').set(as('outsider'));
      expect(outsider.body).toEqual([]);
    });

    it('requires a session', async () => {
      expect((await http().get('/api/v1/workspaces')).status).toBe(401);
    });
  });

  describe('POST /api/v1/workspaces', () => {
    it('refuses a member with 403', async () => {
      const res = await http().post('/api/v1/workspaces').set(as('member')).send({ name: 'Nope' });
      expect(res.status).toBe(403);
    });

    it('refuses an admin who is not the install owner with 403', async () => {
      const res = await http().post('/api/v1/workspaces').set(as('admin')).send({ name: 'Nope' });
      expect(res.status).toBe(403);
      const orgs = await t.db.db.select().from(authSchema.organization);
      expect(orgs).toHaveLength(2);
    });

    it('lets the install owner create a workspace and become its owner', async () => {
      const res = await http()
        .post('/api/v1/workspaces')
        .set(as('owner'))
        .send({ name: 'Third Space' });
      expect(res.status).toBe(201);
      const created = WorkspaceSummary.parse(res.body);
      expect(created).toMatchObject({ name: 'Third Space', role: 'owner' });
      const [member] = await t.db.db
        .select()
        .from(authSchema.member)
        .where(eq(authSchema.member.organizationId, created.id));
      expect(member).toMatchObject({ userId: ids.owner, role: 'owner' });
      const [org] = await t.db.db
        .select()
        .from(authSchema.organization)
        .where(eq(authSchema.organization.id, created.id));
      expect(org!.slug).toMatch(/^third-space-[0-9a-f]{6}$/);
    });

    it('rejects an invalid body with 400', async () => {
      const res = await http().post('/api/v1/workspaces').set(as('owner')).send({ name: '  ' });
      expect(res.status).toBe(400);
    });
  });

  describe('GET /api/v1/workspaces/:workspaceId/members', () => {
    it('lists members for a member', async () => {
      const res = await http().get(`/api/v1/workspaces/${workspaceId}/members`).set(as('member'));
      expect(res.status).toBe(200);
      const list = MemberSummary.array().parse(res.body);
      expect(list.every((m) => m.emailVerified === false)).toBe(true);
      expect(list.map((m) => [m.userId, m.role]).sort()).toEqual(
        [
          [ids.owner, 'owner'],
          [ids.admin, 'admin'],
          [ids.member, 'member'],
        ].sort(),
      );
      expect(list.find((m) => m.userId === ids.admin)).toMatchObject({
        name: 'admin',
        email: 'admin@example.com',
      });
    });

    it('returns 404 for a non-member, the same as for a workspace that does not exist', async () => {
      const real = await http()
        .get(`/api/v1/workspaces/${workspaceId}/members`)
        .set(as('outsider'));
      const missing = await http().get('/api/v1/workspaces/nope/members').set(as('outsider'));
      expect(real.status).toBe(404);
      expect(missing.status).toBe(404);
      expect(real.body).toEqual(missing.body);
    });

    it('returns 404 for a member of a different workspace', async () => {
      await t.auth.api.addMember({
        body: { userId: ids.outsider!, role: 'member', organizationId: otherWorkspaceId },
      });
      const res = await http().get(`/api/v1/workspaces/${workspaceId}/members`).set(as('outsider'));
      expect(res.status).toBe(404);
    });
  });

  describe('PATCH /api/v1/workspaces/:workspaceId/members/:userId', () => {
    const patch = (who: string, target: string, body: object, ws = workspaceId) =>
      http().patch(`/api/v1/workspaces/${ws}/members/${target}`).set(as(who)).send(body);

    it('returns 403 for a plain member', async () => {
      const res = await patch('member', ids.member!, { role: 'admin' });
      expect(res.status).toBe(403);
      expect(await roleOf(ids.member!)).toBe('member');
    });

    it('returns 404 for a non-member', async () => {
      const res = await patch('outsider', ids.member!, { role: 'admin' });
      expect(res.status).toBe(404);
    });

    it('lets an admin change a member role through the Better Auth server API', async () => {
      const up = await patch('admin', ids.member!, { role: 'admin' });
      expect(up.status).toBe(200);
      expect(MemberSummary.parse(up.body)).toMatchObject({ userId: ids.member, role: 'admin' });
      expect(await roleOf(ids.member!)).toBe('admin');
      const down = await patch('owner', ids.member!, { role: 'member' });
      expect(down.status).toBe(200);
      expect(await roleOf(ids.member!)).toBe('member');
    });

    it('lets only the owner demote an admin: 403 for an admin, 200 for the owner', async () => {
      await patch('owner', ids.member!, { role: 'admin' });
      const byAdmin = await patch('admin', ids.member!, { role: 'member' });
      expect(byAdmin.status).toBe(403);
      expect(await roleOf(ids.member!)).toBe('admin');
      const byOwner = await patch('owner', ids.member!, { role: 'member' });
      expect(byOwner.status).toBe(200);
      expect(await roleOf(ids.member!)).toBe('member');
    });

    it('returns 404 when the target is not a member of that workspace', async () => {
      const res = await patch('owner', ids.outsider!, { role: 'admin' });
      expect(res.status).toBe(404);
    });

    it('cannot change the owner role: 409, even by the owner', async () => {
      const byAdmin = await patch('admin', ids.owner!, { role: 'member' });
      expect(byAdmin.status).toBe(409);
      const byOwner = await patch('owner', ids.owner!, { role: 'admin' });
      expect(byOwner.status).toBe(409);
      expect(await roleOf(ids.owner!)).toBe('owner');
    });

    it("rejects role 'owner' in the body with 400", async () => {
      const res = await patch('owner', ids.member!, { role: 'owner' });
      expect(res.status).toBe(400);
      expect(await roleOf(ids.member!)).toBe('member');
    });

    it('rejects an unknown role and a missing body with 400', async () => {
      expect((await patch('owner', ids.member!, { role: 'guest' })).status).toBe(400);
      expect((await patch('owner', ids.member!, {})).status).toBe(400);
    });
  });

  describe('POST /api/v1/workspaces/:workspaceId/leave', () => {
    const leave = (who: string, ws = workspaceId) =>
      http().post(`/api/v1/workspaces/${ws}/leave`).set(as(who)).send({});

    it('returns 409 for the owner and keeps them a member', async () => {
      const res = await leave('owner');
      expect(res.status).toBe(409);
      expect(await roleOf(ids.owner!)).toBe('owner');
    });

    it('returns 404 for a non-member', async () => {
      expect((await leave('outsider')).status).toBe(404);
    });

    it('lets a member leave, after which the workspace is gone for them', async () => {
      const res = await leave('member');
      expect(res.status).toBe(204);
      expect(await roleOf(ids.member!)).toBeUndefined();
      const after = await http().get(`/api/v1/workspaces/${workspaceId}/members`).set(as('member'));
      expect(after.status).toBe(404);
    });

    it('lets an admin leave', async () => {
      const res = await leave('admin');
      expect(res.status).toBe(204);
      expect(await roleOf(ids.admin!)).toBeUndefined();
    });
  });

  describe('Better Auth organization routes over HTTP', () => {
    it('stay refused with 403 even for the workspace owner', async () => {
      const res = await http()
        .post('/api/auth/organization/update-member-role')
        .set(as('owner'))
        .set('origin', 'http://localhost:4300')
        .send({ role: 'admin', memberId: 'x', organizationId: workspaceId });
      expect(res.status).toBe(403);
    });
  });
});
