import { authSchema, memberPermissions, workspaceModules } from '@briefroom/db';
import { ForbiddenException } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { InstallService } from '../src/install/install.service.ts';
import { SetupService } from '../src/install/setup.service.ts';
import { WorkspaceModulesService } from '../src/module-registry/workspace-modules.service.ts';
import { MemberPermissionsService } from '../src/module-registry/member-permissions.service.ts';
import { createTestApp, makeInstallOwner, type TestApp } from './helpers.ts';

const PASSWORD = 'correct horse battery';

describe('switching modules and module permissions', () => {
  let t: TestApp;
  let ws: string;
  const ids: Record<string, string> = {};
  const cookies: Record<string, string> = {};

  const http = () => request(t.app.getHttpServer());
  const base = () => `/api/v1/workspaces/${ws}`;
  const notes = () => `${base()}/m/testkit/notes`;
  const as = (who: string) => ({ cookie: cookies[who]! });
  const setModule = (who: string, body: object) =>
    http().put(`${base()}/modules/testkit`).set(as(who)).send(body);
  const grant = (who: string, target: string, granted: boolean, over: object = {}) =>
    http()
      .put(`${base()}/members/${ids[target]}/permissions`)
      .set(as(who))
      .send({ moduleId: 'testkit', key: 'write-notes', granted, ...over });

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

  beforeAll(async () => {
    t = await createTestApp();
    await addUser('owner');
    await makeInstallOwner(t, ids.owner!);
    ws = (
      await t.auth.api.createOrganization({
        body: { name: 'Acme', slug: 'acme', userId: ids.owner! },
      })
    ).id;
    await addUser('admin', 'admin');
    await addUser('member', 'member');
    await addUser('outsider');
  });

  afterAll(async () => {
    await t.close();
  });

  it('starts with every module off and answers 409 module_off', async () => {
    const res = await http().get(notes()).set(as('member'));
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'module_off', moduleId: 'testkit' });
    const post = await http().post(notes()).set(as('owner')).send({ text: 'x' });
    expect(post.status).toBe(409);
  });

  it('lists the registered modules with their state', async () => {
    const res = await http().get(`${base()}/modules`).set(as('member'));
    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      expect.objectContaining({ id: 'testkit', name: 'Testkit', enabled: false }),
    ]);
  });

  it('lets only an admin switch a module', async () => {
    expect((await setModule('member', { enabled: true })).status).toBe(403);
    expect((await setModule('outsider', { enabled: true })).status).toBe(404);
    expect((await setModule('admin', { enabled: true })).status).toBe(200);
    const row = await t.db.db.select().from(workspaceModules);
    expect(row[0]).toMatchObject({ moduleId: 'testkit', enabled: true, createdBy: ids.admin });
    expect((await http().get(notes()).set(as('member'))).status).toBe(200);
  });

  it('rejects an unknown module and an empty body', async () => {
    const unknown = await http()
      .put(`${base()}/modules/nope`)
      .set(as('admin'))
      .send({ enabled: true });
    expect(unknown.status).toBe(404);
    expect((await setModule('admin', {})).status).toBe(400);
  });

  it('keeps notes when the module is switched off and on again', async () => {
    const created = await http().post(notes()).set(as('admin')).send({ text: 'keep me' });
    expect(created.status).toBe(201);
    expect((await setModule('admin', { enabled: false })).status).toBe(200);
    expect((await http().get(notes()).set(as('admin'))).status).toBe(409);
    expect((await setModule('admin', { enabled: true })).status).toBe(200);
    const list = await http().get(notes()).set(as('admin'));
    expect(list.body.map((n: { text: string }) => n.text)).toEqual(['keep me']);
  });

  it('refuses a member without the permission and lets an admin through', async () => {
    const denied = await http().post(notes()).set(as('member')).send({ text: 'no' });
    expect(denied.status).toBe(403);
    const ok = await http().post(notes()).set(as('admin')).send({ text: 'admin note' });
    expect(ok.status).toBe(201);
    const owner = await http().post(notes()).set(as('owner')).send({ text: 'owner note' });
    expect(owner.status).toBe(201);
  });

  it('grants and revokes a permission, admin only', async () => {
    expect((await grant('member', 'member', true)).status).toBe(403);
    expect((await grant('outsider', 'member', true)).status).toBe(404);
    expect((await grant('admin', 'member', true)).status).toBe(200);
    expect((await http().post(notes()).set(as('member')).send({ text: 'mine' })).status).toBe(201);

    const view = await http().get(`${base()}/members/${ids.member}/permissions`).set(as('admin'));
    expect(view.status).toBe(200);
    expect(view.body).toEqual([
      { moduleId: 'testkit', key: 'write-notes', granted: true, implied: false },
    ]);

    expect((await grant('admin', 'member', false)).status).toBe(200);
    expect((await http().post(notes()).set(as('member')).send({ text: 'no' })).status).toBe(403);
    const after = await http().get(`${base()}/members/${ids.member}/permissions`).set(as('admin'));
    expect(after.body[0]).toMatchObject({ granted: false });
  });

  it('is idempotent when granting twice', async () => {
    expect((await grant('admin', 'member', true)).status).toBe(200);
    expect((await grant('admin', 'member', true)).status).toBe(200);
    const rows = await t.db.db
      .select()
      .from(memberPermissions)
      .where(eq(memberPermissions.userId, ids.member!));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ createdBy: ids.admin, workspaceId: ws });
    await grant('admin', 'member', false);
  });

  it('reports every permission as implied for an owner or admin', async () => {
    for (const target of ['owner', 'admin']) {
      const res = await http().get(`${base()}/members/${ids[target]}/permissions`).set(as('admin'));
      expect(res.body).toEqual([
        { moduleId: 'testkit', key: 'write-notes', granted: true, implied: true },
      ]);
    }
  });

  it('answers 404 for the permissions of a non-member', async () => {
    const res = await http().get(`${base()}/members/${ids.outsider}/permissions`).set(as('admin'));
    expect(res.status).toBe(404);
    expect((await grant('admin', 'outsider', true)).status).toBe(404);
  });

  it('answers 400 for an unregistered module or key', async () => {
    expect((await grant('admin', 'member', true, { moduleId: 'nope' })).status).toBe(400);
    expect((await grant('admin', 'member', true, { key: 'nope' })).status).toBe(400);
  });

  it('reads the default settings before any save', async () => {
    const svc = t.app.get(WorkspaceModulesService);
    expect(await svc.settings(ws, 'testkit')).toEqual({ greeting: 'hello' });
  });

  it('stores parsed settings and rejects an invalid value without echoing it', async () => {
    const bad = await setModule('admin', { settings: { greeting: 'x'.repeat(41) } });
    expect(bad.status).toBe(400);
    expect(JSON.stringify(bad.body)).not.toContain('xxxxx');
    const ok = await setModule('admin', { settings: { greeting: 'hi', extra: 1 } });
    expect(ok.status).toBe(200);
    const svc = t.app.get(WorkspaceModulesService);
    expect(await svc.settings(ws, 'testkit')).toEqual({ greeting: 'hi' });
    const [row] = await t.db.db
      .select()
      .from(workspaceModules)
      .where(and(eq(workspaceModules.workspaceId, ws), eq(workspaceModules.moduleId, 'testkit')));
    expect(row!.settings).toEqual({ greeting: 'hi' });
    expect(row!.enabled).toBe(true);
  });

  describe('notes tied to a project', () => {
    let projectId: string;

    it('lets an admin attach a note to a project', async () => {
      const created = await http().post(`${base()}/projects`).set(as('admin')).send({ name: 'P' });
      projectId = created.body.id;
      const res = await http().post(notes()).set(as('admin')).send({ text: 'p', projectId });
      expect(res.status).toBe(201);
      expect(res.body.projectId).toBe(projectId);
    });

    it('answers 404 to a member who cannot see the project, and for an unknown project', async () => {
      await grant('admin', 'member', true);
      const hidden = await http().post(notes()).set(as('member')).send({ text: 'p', projectId });
      expect(hidden.status).toBe(404);
      const unknown = await http()
        .post(notes())
        .set(as('member'))
        .send({ text: 'p', projectId: '00000000-0000-4000-8000-000000000000' });
      expect(unknown.status).toBe(404);
      const bad = await http().post(notes()).set(as('member')).send({ text: 'p', projectId: 'x' });
      expect(bad.status).toBe(400);
    });
  });

  it('deletes permissions on removal, so a rejoin starts clean (R110)', async () => {
    await grant('admin', 'member', true);
    const link = await http().post(`${base()}/invites`).set(as('owner')).send({});
    const token = (link.body.url as string).split('/join/')[1]!;

    expect((await http().delete(`${base()}/members/${ids.member}`).set(as('owner'))).status).toBe(
      200,
    );
    const rows = await t.db.db
      .select()
      .from(memberPermissions)
      .where(eq(memberPermissions.userId, ids.member!));
    expect(rows).toHaveLength(0);

    await login('member');
    expect((await http().post(`/api/v1/join/${token}/accept`).set(as('member'))).body).toEqual({
      status: 'pending',
    });
    const pending = await http().get(`${base()}/join-requests`).set(as('owner'));
    const row = (pending.body as { id: string; userId: string }[]).find(
      (r) => r.userId === ids.member,
    )!;
    expect(
      (await http().post(`${base()}/join-requests/${row.id}/approve`).set(as('owner'))).status,
    ).toBe(200);
    const denied = await http().post(notes()).set(as('member')).send({ text: 'again' });
    expect(denied.status).toBe(403);
  });

  it('deletes permissions when a member leaves', async () => {
    await addUser('leaver', 'member');
    await grant('admin', 'leaver', true);
    expect((await http().post(`${base()}/leave`).set(as('leaver'))).status).toBe(204);
    const rows = await t.db.db
      .select()
      .from(memberPermissions)
      .where(eq(memberPermissions.userId, ids.leaver!));
    expect(rows).toHaveLength(0);
  });

  it('clears grants on promotion and demotion, so a cycle does not bring them back (R112)', async () => {
    await addUser('cycler', 'member');
    await grant('admin', 'cycler', true);
    const role = (r: string) =>
      http().patch(`${base()}/members/${ids.cycler}`).set(as('owner')).send({ role: r });
    expect((await role('admin')).status).toBe(200);
    expect((await role('member')).status).toBe(200);
    const denied = await http().post(notes()).set(as('cycler')).send({ text: 'back' });
    expect(denied.status).toBe(403);
    const view = await http().get(`${base()}/members/${ids.cycler}/permissions`).set(as('admin'));
    expect(view.body.every((p: { granted: boolean }) => !p.granted)).toBe(true);
  });

  it('re-reads the caller role under the lock and refuses a demoted admin (item 3)', async () => {
    const stale = {
      userId: ids.member!,
      workspaceId: ws,
      role: 'admin' as const,
      visibleProjectIds: 'all' as const,
      permissions: new Set<string>(),
      actor: { userId: ids.member!, via: 'web' as const },
    };
    await expect(
      t.app
        .get(MemberPermissionsService)
        .set(stale, ids.cycler!, { moduleId: 'testkit', key: 'write-notes', granted: true }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('keeps project A and project B apart for a member', async () => {
    await grant('admin', 'member', true);
    const a = (await http().post(`${base()}/projects`).set(as('admin')).send({ name: 'A' })).body
      .id;
    const b = (await http().post(`${base()}/projects`).set(as('admin')).send({ name: 'B' })).body
      .id;
    const added = await http()
      .post(`${base()}/projects/${a}/members`)
      .set(as('admin'))
      .send({ userId: ids.member });
    expect(added.status).toBeLessThan(300);
    const onB = await http().post(notes()).set(as('member')).send({ text: 'b', projectId: b });
    expect(onB.status).toBe(404);
    const onA = await http().post(notes()).set(as('member')).send({ text: 'a', projectId: a });
    expect(onA.status).toBe(201);
  });

  it('gives a fixed message when a grant targets an owner or admin', async () => {
    const res = await grant('admin', 'admin', true);
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({
      code: 'implied_by_role',
      message: 'Owners and admins have every module permission.',
    });
  });

  it('removes the new workspace when enabling its modules fails', async () => {
    const spy = vi
      .spyOn(WorkspaceModulesService.prototype, 'enableStarting')
      .mockRejectedValueOnce(new Error('boom'));
    const res = await http()
      .post('/api/v1/workspaces')
      .set(as('owner'))
      .send({ name: 'Doomed', modules: ['testkit'] });
    spy.mockRestore();
    expect(res.status).toBe(500);
    const left = await t.db.db
      .select()
      .from(authSchema.organization)
      .where(eq(authSchema.organization.name, 'Doomed'));
    expect(left).toHaveLength(0);
  });

  it('lets the install owner start a new workspace with chosen modules, and rejects unknown ones', async () => {
    const bad = await http()
      .post('/api/v1/workspaces')
      .set(as('owner'))
      .send({ name: 'Two', modules: ['nope'] });
    expect(bad.status).toBe(400);
    const res = await http()
      .post('/api/v1/workspaces')
      .set(as('owner'))
      .send({ name: 'Two', modules: ['testkit'] });
    expect(res.status).toBe(201);
    const list = await http().get(`/api/v1/workspaces/${res.body.id}/modules`).set(as('owner'));
    expect(list.body[0]).toMatchObject({ id: 'testkit', enabled: true });
    const plain = await http().post('/api/v1/workspaces').set(as('owner')).send({ name: 'Three' });
    const off = await http().get(`/api/v1/workspaces/${plain.body.id}/modules`).set(as('owner'));
    expect(off.body[0]).toMatchObject({ id: 'testkit', enabled: false });
  });
});

describe('modules at first-run setup', () => {
  let t: TestApp;
  let code: string;

  beforeAll(async () => {
    t = await createTestApp();
    code = (await t.app.get(InstallService).ensureInstall()).setupCode!;
  });

  afterAll(async () => {
    await t.close();
  });

  const http = () => request(t.app.getHttpServer());
  const body = (over: Record<string, unknown> = {}) => ({
    code,
    name: 'Ada',
    email: 'ada@example.com',
    password: PASSWORD,
    ...over,
  });

  it('lists the registered modules anonymously while setup is open', async () => {
    const res = await http().get('/api/v1/setup/modules');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      expect.objectContaining({ id: 'testkit', name: 'Testkit', description: expect.any(String) }),
    ]);
    expect(res.body[0]).not.toHaveProperty('enabled');
  });

  it('answers 400 for an unknown starting module and does not run setup', async () => {
    const res = await http()
      .post('/api/v1/setup')
      .send(body({ modules: ['nope'] }));
    expect(res.status).toBe(400);
    expect(await t.app.get(SetupService).needsSetup()).toBe(true);
  });

  it('starts the workspace with the chosen modules on', async () => {
    const res = await http()
      .post('/api/v1/setup')
      .send(body({ modules: ['testkit'] }));
    expect(res.status).toBe(201);
    const cookie = (res.headers['set-cookie'] as unknown as string[])
      .map((c) => c.split(';')[0])
      .join('; ');
    const list = await http()
      .get(`/api/v1/workspaces/${res.body.workspaceId}/modules`)
      .set({ cookie });
    expect(list.body).toEqual([expect.objectContaining({ id: 'testkit', enabled: true })]);
    const notes = await http()
      .get(`/api/v1/workspaces/${res.body.workspaceId}/m/testkit/notes`)
      .set({ cookie });
    expect(notes.status).toBe(200);
  });

  it('answers 410 once setup is done, like the other setup routes', async () => {
    const res = await http().get('/api/v1/setup/modules');
    expect(res.status).toBe(410);
  });
});
