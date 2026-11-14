import { inviteLinks, projects } from '@briefroom/db';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, makeInstallOwner, type TestApp } from './helpers.ts';

const PASSWORD = 'correct horse battery';
const DAY = 24 * 60 * 60 * 1000;

describe('invite links', () => {
  let t: TestApp;
  let ws: string;
  let ws2: string;
  let otherProjectId: string;
  const ids: Record<string, string> = {};
  const cookies: Record<string, string> = {};

  const http = () => request(t.app.getHttpServer());
  const base = `/api/v1/workspaces`;
  const as = (who: string) => ({ cookie: cookies[who]! });
  const create = (who: string, body: object = {}, w = ws) =>
    http().post(`${base}/${w}/invites`).set(as(who)).send(body);
  const tokenOf = (url: string) => url.split('/join/')[1]!;
  const lookup = (token: string) => http().get(`/api/v1/join/${token}`);
  const row = async (id: string) =>
    (await t.db.db.select().from(inviteLinks).where(eq(inviteLinks.id, id)))[0]!;

  beforeAll(async () => {
    t = await createTestApp();
    for (const key of ['owner', 'admin', 'member']) {
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
    const [p] = await t.db.db
      .insert(projects)
      .values({
        workspaceId: ws2,
        name: 'Elsewhere',
        createdBy: ids.owner!,
        createdVia: 'system',
        updatedBy: ids.owner!,
        updatedVia: 'system',
      })
      .returning();
    otherProjectId = p!.id;
  });

  afterAll(async () => {
    await t.close();
  });

  it('creates a link with the defaults and returns the token only once', async () => {
    const before = Date.now();
    const res = await create('admin');
    expect(res.status).toBe(201);
    expect(res.body.url).toMatch(/^http:\/\/localhost:4300\/join\/[A-Za-z0-9_-]{43}$/);
    const stored = await row(res.body.id);
    expect(stored).toMatchObject({
      role: 'member',
      maxUses: null,
      uses: 0,
      requiresApproval: false,
      projectIds: [],
      revokedAt: null,
      workspaceId: ws,
      createdBy: ids.admin,
    });
    expect(stored.tokenHash).not.toContain(tokenOf(res.body.url));
    const expires = new Date(res.body.expiresAt).getTime();
    expect(Math.abs(expires - (before + 7 * DAY))).toBeLessThan(60_000);
  });

  it('forces approval on admin links, on create and on regenerate', async () => {
    const res = await create('admin', { role: 'admin', requiresApproval: false });
    expect(res.status).toBe(201);
    expect((await row(res.body.id)).requiresApproval).toBe(true);
    const regen = await http()
      .post(`${base}/${ws}/invites/${res.body.id}/regenerate`)
      .set(as('admin'));
    expect((await row(regen.body.id)).requiresApproval).toBe(true);
    // Stored state the CHECK normally forbids: regenerate must still force approval on it.
    const pool = t.db.db.$client;
    await pool.query('ALTER TABLE invite_links DROP CONSTRAINT invite_links_admin_needs_approval');
    try {
      await pool.query('UPDATE invite_links SET requires_approval = false WHERE id = $1', [
        regen.body.id,
      ]);
      const again = await http()
        .post(`${base}/${ws}/invites/${regen.body.id}/regenerate`)
        .set(as('admin'));
      expect((await row(again.body.id)).requiresApproval).toBe(true);
    } finally {
      await pool.query('UPDATE invite_links SET requires_approval = true WHERE role = $1', [
        'admin',
      ]);
      await pool.query(
        `ALTER TABLE invite_links ADD CONSTRAINT invite_links_admin_needs_approval CHECK (role <> 'admin' or requires_approval)`,
      );
    }
  });

  it('refuses a member with 403', async () => {
    expect((await create('member')).status).toBe(403);
    expect((await http().get(`${base}/${ws}/invites`).set(as('member'))).status).toBe(403);
  });

  it('rejects invalid input with 400', async () => {
    expect((await create('admin', { expiresInDays: 91 })).status).toBe(400);
    expect((await create('admin', { maxUses: 0 })).status).toBe(400);
    expect((await create('admin', { role: 'owner' })).status).toBe(400);
  });

  it('rejects a project from another workspace with 400 invalid_project', async () => {
    const res = await create('admin', { projectIds: [otherProjectId] });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_project');
  });

  it('accepts a project from this workspace', async () => {
    const proj = await http()
      .post(`${base}/${ws}/projects`)
      .set(as('admin'))
      .send({ name: 'Mine' });
    const res = await create('admin', { projectIds: [proj.body.id], role: 'admin', maxUses: 3 });
    expect(res.status).toBe(201);
    expect(await row(res.body.id)).toMatchObject({
      projectIds: [proj.body.id],
      role: 'admin',
      maxUses: 3,
    });
  });

  it('lists only active links and never a token or hash', async () => {
    const live = await create('admin');
    const revoked = await create('admin');
    await http().delete(`${base}/${ws}/invites/${revoked.body.id}`).set(as('admin'));
    const expired = await create('admin');
    await t.db.db
      .update(inviteLinks)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(inviteLinks.id, expired.body.id));
    const spent = await create('admin', { maxUses: 1 });
    await t.db.db.update(inviteLinks).set({ uses: 1 }).where(eq(inviteLinks.id, spent.body.id));
    await create('owner', {}, ws2);

    const res = await http().get(`${base}/${ws}/invites`).set(as('admin'));
    expect(res.status).toBe(200);
    const listed = res.body.map((i: { id: string }) => i.id);
    expect(listed).toContain(live.body.id);
    for (const gone of [revoked, expired, spent]) expect(listed).not.toContain(gone.body.id);
    expect(res.body.length).toBe(listed.length);
    expect(res.body[0]).toMatchObject({ createdBy: 'admin', role: expect.any(String) });
    const text = JSON.stringify(res.body);
    expect(text).not.toContain(tokenOf(live.body.url));
    expect(text).not.toMatch(/token|hash|url/i);
  });

  it('revokes with 204 and 404s for unknown, foreign, repeated or malformed ids', async () => {
    const made = await create('admin');
    const del = (id: string, w = ws) =>
      http().delete(`${base}/${w}/invites/${id}`).set(as('admin'));
    expect((await del(made.body.id)).status).toBe(204);
    expect((await row(made.body.id)).revokedAt).not.toBeNull();
    expect((await del(made.body.id)).status).toBe(404);
    expect((await del('00000000-0000-4000-8000-000000000000')).status).toBe(404);
    expect((await del('not-a-uuid')).status).toBe(404);
    const foreign = await create('owner', {}, ws2);
    expect((await del(foreign.body.id)).status).toBe(404);
    expect((await row(foreign.body.id)).revokedAt).toBeNull();
  });

  it('regenerates: the old token dies, the new one lives, settings carry over', async () => {
    const old = await create('admin', { expiresInDays: 30, maxUses: 5, requiresApproval: true });
    const res = await http()
      .post(`${base}/${ws}/invites/${old.body.id}/regenerate`)
      .set(as('admin'));
    expect(res.status).toBe(201);
    expect(res.body.id).not.toBe(old.body.id);
    expect(await row(res.body.id)).toMatchObject({ maxUses: 5, requiresApproval: true, uses: 0 });
    const days = (new Date(res.body.expiresAt).getTime() - Date.now()) / DAY;
    expect(Math.round(days)).toBe(30);
    expect((await lookup(tokenOf(old.body.url))).body).toEqual({ valid: false });
    expect((await lookup(tokenOf(res.body.url))).body).toEqual({
      valid: true,
      workspaceName: 'Acme',
      role: 'member',
      requiresApproval: true,
    });
    const again = await http()
      .post(`${base}/${ws}/invites/${old.body.id}/regenerate`)
      .set(as('admin'));
    expect(again.status).toBe(404);
  });

  it('404s regenerate for a malformed or foreign id', async () => {
    const regen = (id: string) =>
      http().post(`${base}/${ws}/invites/${id}/regenerate`).set(as('admin'));
    expect((await regen('nope')).status).toBe(404);
    const foreign = await create('owner', {}, ws2);
    expect((await regen(foreign.body.id)).status).toBe(404);
  });

  it('looks up a valid token without a session, and gives exactly {valid:false} otherwise', async () => {
    const made = await create('admin');
    const ok = await lookup(tokenOf(made.body.url));
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({
      valid: true,
      workspaceName: 'Acme',
      role: 'member',
      requiresApproval: false,
    });

    const revoked = await create('admin');
    await http().delete(`${base}/${ws}/invites/${revoked.body.id}`).set(as('admin'));
    const expired = await create('admin');
    await t.db.db
      .update(inviteLinks)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(inviteLinks.id, expired.body.id));
    const spent = await create('admin', { maxUses: 1 });
    await t.db.db.update(inviteLinks).set({ uses: 1 }).where(eq(inviteLinks.id, spent.body.id));

    for (const token of [
      tokenOf(revoked.body.url),
      tokenOf(expired.body.url),
      tokenOf(spent.body.url),
      'a'.repeat(43),
      'x',
    ]) {
      const res = await lookup(token);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ valid: false });
    }
  });
});
