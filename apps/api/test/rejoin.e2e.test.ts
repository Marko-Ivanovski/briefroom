import { authSchema, inviteLinks, joinRequests, workspaceRemovals } from '@briefroom/db';
import { and, eq } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, makeInstallOwner, type TestApp } from './helpers.ts';

const PASSWORD = 'correct horse battery';

describe('rejoining after removal', () => {
  let t: TestApp;
  let ws: string;
  const ids: Record<string, string> = {};
  const cookies: Record<string, string> = {};

  const http = () => request(t.app.getHttpServer());
  const base = () => `/api/v1/workspaces/${ws}`;
  const as = (who: string) => ({ cookie: cookies[who]! });
  const tokenOf = (url: string) => url.split('/join/')[1]!;

  async function login(key: string) {
    const res = await t.auth.api.signInEmail({
      body: { email: `${key}@example.com`, password: PASSWORD },
      asResponse: true,
    });
    cookies[key] = res.headers
      .getSetCookie()
      .map((c) => c.split(';')[0])
      .join('; ');
  }

  async function addUser(key: string, role?: 'admin' | 'member') {
    const { user } = await t.auth.api.createUser({
      body: { email: `${key}@example.com`, password: PASSWORD, name: key },
    });
    ids[key] = user.id;
    await login(key);
    if (role) {
      await t.auth.api.addMember({ body: { userId: user.id, role, organizationId: ws } });
    }
  }

  const invite = async (who: string, body: object = {}) => {
    const res = await http().post(`${base()}/invites`).set(as(who)).send(body);
    expect(res.status).toBe(201);
    return { id: res.body.id as string, token: tokenOf(res.body.url) };
  };
  const lookup = (token: string) => http().get(`/api/v1/join/${token}`);
  const accept = (token: string, who: string) =>
    http().post(`/api/v1/join/${token}/accept`).set(as(who));
  const isMember = async (key: string) =>
    (
      await t.db.db
        .select()
        .from(authSchema.member)
        .where(
          and(eq(authSchema.member.userId, ids[key]!), eq(authSchema.member.organizationId, ws)),
        )
    ).length > 0;
  const removalRows = (key: string) =>
    t.db.db.select().from(workspaceRemovals).where(eq(workspaceRemovals.userId, ids[key]!));

  beforeAll(async () => {
    t = await createTestApp();
    await addUser('owner');
    await makeInstallOwner(t, ids.owner!);
    ws = (
      await t.auth.api.createOrganization({
        body: { name: 'Acme', slug: 'acme', userId: ids.owner! },
      })
    ).id;
    for (const key of ['admin', 'bob', 'leaver']) {
      await addUser(key, key === 'admin' ? 'admin' : 'member');
    }
  });

  afterAll(async () => {
    await t.close();
  });

  it('revokes the active links a removed admin created, and their pending requests', async () => {
    await addUser('admin2', 'admin');
    const mine = await invite('admin2');
    const theirs = await invite('owner');
    await addUser('applicant');
    const approval = await invite('admin2', { requiresApproval: true });
    expect((await accept(approval.token, 'applicant')).body).toEqual({ status: 'pending' });

    const removed = await http().delete(`${base()}/members/${ids.admin2}`).set(as('owner'));
    expect(removed.status).toBe(200);

    expect((await lookup(mine.token)).body).toEqual({ valid: false });
    expect((await lookup(approval.token)).body).toEqual({ valid: false });
    expect((await lookup(theirs.token)).body).toMatchObject({ valid: true });
    const [revoked] = await t.db.db.select().from(inviteLinks).where(eq(inviteLinks.id, mine.id));
    expect(revoked!.revokedAt).not.toBeNull();
    expect(revoked!.updatedBy).toBe(ids.owner);
    const [request] = await t.db.db
      .select()
      .from(joinRequests)
      .where(eq(joinRequests.userId, ids.applicant!));
    expect(request!.status).toBe('declined');
  });

  it('turns a removed member into a pending request on a link that needs no approval', async () => {
    const link = await invite('owner');
    expect((await http().delete(`${base()}/members/${ids.bob}`).set(as('owner'))).status).toBe(200);
    expect(await removalRows('bob')).toHaveLength(1);
    await login('bob');

    const res = await accept(link.token, 'bob');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'pending' });
    expect(await isMember('bob')).toBe(false);

    const pending = await http().get(`${base()}/join-requests`).set(as('owner'));
    const row = (pending.body as { id: string; userId: string }[]).find(
      (r) => r.userId === ids.bob,
    );
    expect(row).toBeDefined();

    const approved = await http()
      .post(`${base()}/join-requests/${row!.id}/approve`)
      .set(as('owner'));
    expect(approved.status).toBe(200);
    expect(await isMember('bob')).toBe(true);
    expect(await removalRows('bob')).toHaveLength(0);
  });

  it('lets an approved member who never left again join normally next time', async () => {
    const link = await invite('owner');
    await http().post(`${base()}/leave`).set(as('bob'));
    await login('bob');
    expect((await accept(link.token, 'bob')).body).toEqual({ status: 'pending' });
  });

  it('treats leaving like removal', async () => {
    const link = await invite('owner');
    const left = await http().post(`${base()}/leave`).set(as('leaver'));
    expect(left.status).toBe(204);
    expect(await removalRows('leaver')).toHaveLength(1);
    await login('leaver');
    expect((await accept(link.token, 'leaver')).body).toEqual({ status: 'pending' });
    expect(await isMember('leaver')).toBe(false);
  });
});
