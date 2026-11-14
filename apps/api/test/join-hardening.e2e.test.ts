import {
  authSchema,
  inviteLinks,
  projectAccessChecklist,
  projectMembers,
  type Db,
} from '@briefroom/db';
import { ConflictException } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { DB } from '../src/database/database.module.ts';
import { ProjectMembersService } from '../src/projects/project-members.service.ts';
import { createTestApp, makeInstallOwner, type TestApp } from './helpers.ts';

const PASSWORD = 'correct horse battery';

describe('joining under races and failures', () => {
  let t: TestApp;
  let ws: string;
  let plain: string;
  let linked: string;
  const ids: Record<string, string> = {};
  const cookies: Record<string, string> = {};

  const http = () => request(t.app.getHttpServer());
  const base = `/api/v1/workspaces`;
  const as = (who: string) => ({ cookie: cookies[who]! });
  const cookieOf = (setCookie: string[]) => setCookie.map((c) => c.split(';')[0]).join('; ');
  const invite = async (body: object = {}) => {
    const res = await http().post(`${base}/${ws}/invites`).set(as('admin')).send(body);
    expect(res.status).toBe(201);
    return { id: res.body.id as string, token: (res.body.url as string).split('/join/')[1]! };
  };
  const link = async (id: string) =>
    (await t.db.db.select().from(inviteLinks).where(eq(inviteLinks.id, id)))[0]!;
  const accept = (token: string, who: string) =>
    http().post(`/api/v1/join/${token}/accept`).set(as(who));
  const members = async (userId: string) =>
    t.db.db
      .select()
      .from(authSchema.member)
      .where(and(eq(authSchema.member.userId, userId), eq(authSchema.member.organizationId, ws)));
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
    cookies[key] = cookieOf(res.headers.getSetCookie());
  };
  const project = async (body: object) => {
    const res = await http().post(`${base}/${ws}/projects`).set(as('admin')).send(body);
    return res.body.id as string;
  };

  beforeAll(async () => {
    t = await createTestApp();
    for (const key of ['owner', 'admin']) await makeAccount(key);
    await makeInstallOwner(t, ids.owner!);
    ws = (
      await t.auth.api.createOrganization({
        body: { name: 'Acme', slug: 'acme', userId: ids.owner! },
      })
    ).id;
    await t.auth.api.addMember({ body: { userId: ids.admin!, role: 'admin', organizationId: ws } });
    plain = await project({ name: 'Plain' });
    linked = await project({
      name: 'Linked',
      toolLinks: [{ label: 'Wiki', url: 'https://wiki.example.com/l' }],
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await t.close();
  });

  describe.each([
    ['without projects', () => []],
    ['with a project that has a tool link', () => [linked, plain]],
  ])('the same user accepting twice at once, %s', (_label, projectIds) => {
    it('joins once, answers 409 already_member to the other and burns one use', async () => {
      const key = `twin${_label.length}`;
      await makeAccount(key);
      const { id, token } = await invite({ maxUses: 5, projectIds: projectIds() });
      const [a, b] = await Promise.all([accept(token, key), accept(token, key)]);
      expect([a.status, b.status].sort()).toEqual([200, 409]);
      const loser = a.status === 409 ? a : b;
      expect(loser.body.code).toBe('already_member');
      expect(await members(ids[key]!)).toHaveLength(1);
      expect((await link(id)).uses).toBe(1);
      const held = await t.db.db
        .select()
        .from(projectMembers)
        .where(eq(projectMembers.userId, ids[key]!));
      expect(held.map((r) => r.projectId).sort()).toEqual([...projectIds()].sort());
      if (projectIds().length > 0) {
        const items = await t.db.db
          .select()
          .from(projectAccessChecklist)
          .where(eq(projectAccessChecklist.userId, ids[key]!));
        expect(items.length).toBeGreaterThan(0);
      }
    });
  });

  it('refuses a second member row for the same user and workspace at the database', async () => {
    await expect(
      t.db.db.insert(authSchema.member).values({
        id: 'dup-member-row',
        organizationId: ws,
        userId: ids.admin!,
        role: 'member',
        createdAt: new Date(),
      }),
    ).rejects.toThrow();
  });

  it('refuses an admin link without approval at the database', async () => {
    const { id } = await invite({ role: 'admin' });
    await expect(
      t.db.db.update(inviteLinks).set({ requiresApproval: false }).where(eq(inviteLinks.id, id)),
    ).rejects.toThrow();
    expect((await link(id)).requiresApproval).toBe(true);
  });

  it('still holds an admin link for approval if the CHECK were bypassed', async () => {
    await makeAccount('sly');
    const { id, token } = await invite({ role: 'admin' });
    const pool = t.db.db.$client;
    await pool.query('ALTER TABLE invite_links DROP CONSTRAINT invite_links_admin_needs_approval');
    try {
      await pool.query('UPDATE invite_links SET requires_approval = false WHERE id = $1', [id]);
      const res = await accept(token, 'sly');
      expect(res.body).toEqual({ status: 'pending' });
      expect(await members(ids.sly!)).toHaveLength(0);
    } finally {
      await pool.query('UPDATE invite_links SET requires_approval = true WHERE id = $1', [id]);
      await pool.query(
        `ALTER TABLE invite_links ADD CONSTRAINT invite_links_admin_needs_approval CHECK (role <> 'admin' or requires_approval)`,
      );
    }
  });

  it('does not pass internal error codes on to the joiner', async () => {
    await makeAccount('leaky');
    const { id, token } = await invite({ projectIds: [plain] });
    vi.spyOn(ProjectMembersService.prototype, 'add').mockRejectedValueOnce(
      new ConflictException({ code: 'already_on_project', message: 'already_on_project' }),
    );
    const res = await accept(token, 'leaky');
    expect(res.status).toBe(500);
    expect(res.body.code).toBe('join_failed');
    expect(JSON.stringify(res.body)).not.toContain('already_on_project');
    expect(await members(ids.leaky!)).toHaveLength(0);
    expect((await link(id)).uses).toBe(0);
  });

  describe('deleting a half-made account', () => {
    const failDeletesOf = (userTable: object, times: number) => {
      const db = t.app.get<Db>(DB);
      const real = db.delete.bind(db) as (table: never) => unknown;
      let failed = 0;
      vi.spyOn(db, 'delete').mockImplementation(((table: never) => {
        if ((table as object) === userTable && failed < times) {
          failed += 1;
          throw new Error('delete refused');
        }
        return real(table);
      }) as never);
      return () => failed;
    };
    const failedSignUp = async (label: string) => {
      const { token } = await invite();
      vi.spyOn(t.auth.api, 'addMember').mockRejectedValueOnce(new Error('boom'));
      const email = `${label}@example.com`;
      const res = await http()
        .post(`/api/v1/join/${token}/sign-up`)
        .send({ name: label, email, password: PASSWORD });
      const [user] = await t.db.db
        .select()
        .from(authSchema.user)
        .where(eq(authSchema.user.email, email));
      return { res, user };
    };

    it('retries the delete and ends with no account', async () => {
      const failures = failDeletesOf(authSchema.user, 2);
      const { res, user } = await failedSignUp('retried');
      expect(res.status).toBe(500);
      expect(failures()).toBe(2);
      expect(user).toBeUndefined();
    });

    it('never leaves a working session when the delete keeps failing', async () => {
      failDeletesOf(authSchema.user, 99);
      const { res, user } = await failedSignUp('stubborn');
      expect(res.status).toBe(500);
      expect(user).toBeDefined();
      expect(
        await t.db.db
          .select()
          .from(authSchema.session)
          .where(eq(authSchema.session.userId, user!.id)),
      ).toEqual([]);
    });
  });
});
