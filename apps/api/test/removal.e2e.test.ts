import {
  authSchema,
  passwordResetLinks,
  projectAccessChecklist,
  projectMembers,
  projects,
} from '@briefroom/db';
import { and, eq, sql } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PasswordResetLinks } from '../src/members/password-reset-links.service.ts';
import { RevocationService } from '../src/members/revocation.service.ts';
import { createTestApp, makeInstallOwner, type TestApp } from './helpers.ts';

const PASSWORD = 'correct horse battery';

describe('member removal and immediate revocation', () => {
  let t: TestApp;
  let ws: string;
  let ws2: string;
  let withLinks: string;
  let withoutLinks: string;
  const ids: Record<string, string> = {};
  const cookies: Record<string, string> = {};
  const memberRemovedCalls: [string, string][] = [];
  const projectRemovedCalls: [string, string, string][] = [];

  const http = () => request(t.app.getHttpServer());
  const base = (w = ws) => `/api/v1/workspaces/${w}`;
  const as = (who: string) => ({ cookie: cookies[who]! });
  const del = (who: string, target: string, w = ws) =>
    http()
      .delete(`${base(w)}/members/${target}`)
      .set(as(who));
  const projectsOf = (who: string, w = ws) =>
    http()
      .get(`${base(w)}/projects`)
      .set(as(who));
  const me = (who: string) => http().get('/api/v1/me').set(as(who));
  const isMember = async (key: string, w = ws) =>
    (
      await t.db.db
        .select()
        .from(authSchema.member)
        .where(
          and(eq(authSchema.member.userId, ids[key]!), eq(authSchema.member.organizationId, w)),
        )
    ).length > 0;
  const onProjects = (key: string) =>
    t.db.db.select().from(projectMembers).where(eq(projectMembers.userId, ids[key]!));
  const linkRows = (key: string) =>
    t.db.db.select().from(passwordResetLinks).where(eq(passwordResetLinks.userId, ids[key]!));

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

  async function putOnProjects(key: string) {
    for (const p of [withLinks, withoutLinks]) {
      const res = await http()
        .post(`${base()}/projects/${p}/members`)
        .set(as('owner'))
        .send({ userId: ids[key] });
      expect(res.status).toBe(201);
    }
  }

  beforeAll(async () => {
    t = await createTestApp();
    const revocation = t.app.get(RevocationService);
    revocation.onMemberRemoved(async (w, u) => {
      memberRemovedCalls.push([w, u]);
    });
    revocation.onProjectMemberRemoved(async (w, p, u) => {
      projectRemovedCalls.push([w, p, u]);
    });

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
    await addUser('admin', [{ ws, role: 'admin' }]);
    await addUser('admin2', [{ ws, role: 'admin' }]);
    await addUser('solo', [{ ws, role: 'member' }]);
    await addUser('both', [
      { ws, role: 'member' },
      { ws: ws2, role: 'member' },
    ]);
    await addUser('leaver', [{ ws, role: 'member' }]);

    withLinks = (
      await http()
        .post(`${base()}/projects`)
        .set(as('owner'))
        .send({
          name: 'With links',
          toolLinks: [
            { label: 'Repo', url: 'https://github.com/acme/p' },
            { label: 'Board', url: 'https://acme.atlassian.net/jira/p' },
          ],
        })
    ).body.id;
    withoutLinks = (await http().post(`${base()}/projects`).set(as('owner')).send({ name: 'Bare' }))
      .body.id;
  });

  afterAll(async () => {
    await t.close();
  });

  it('removes a member: every project membership gone, remove checklists undone', async () => {
    await putOnProjects('solo');
    expect((await projectsOf('solo')).status).toBe(200);
    const issued = t.app.get(PasswordResetLinks);
    await issued.issue(ids.solo!, ws, { userId: ids.admin!, via: 'web' });
    await issued.issue(ids.solo!, null, { userId: ids.admin!, via: 'cli' });
    const [before] = await t.db.db.select().from(projects).where(eq(projects.id, withLinks));
    const createdBy = before!.createdBy;

    const res = await del('admin', ids.solo!);
    expect(res.status).toBe(204);

    expect(await isMember('solo')).toBe(false);
    expect(await onProjects('solo')).toHaveLength(0);

    const checklist = await t.db.db
      .select()
      .from(projectAccessChecklist)
      .where(
        and(
          eq(projectAccessChecklist.userId, ids.solo!),
          eq(projectAccessChecklist.kind, 'remove'),
        ),
      );
    expect(checklist).toHaveLength(2);
    expect(checklist.every((c) => c.projectId === withLinks && !c.done)).toBe(true);

    const [after] = await t.db.db.select().from(projects).where(eq(projects.id, withLinks));
    expect(after!.createdBy).toBe(createdBy);
  });

  it('refuses the removed user with 401 when they have no other workspace', async () => {
    expect((await me('solo')).status).toBe(401);
    const sessions = await t.db.db
      .select()
      .from(authSchema.session)
      .where(eq(authSchema.session.userId, ids.solo!));
    expect(sessions).toHaveLength(0);
  });

  it('keeps the session and the other workspace for a user who belongs to two', async () => {
    const issued = t.app.get(PasswordResetLinks);
    await issued.issue(ids.both!, ws, { userId: ids.admin!, via: 'web' });
    await issued.issue(ids.both!, ws2, { userId: ids.owner!, via: 'web' });

    expect((await del('admin', ids.both!)).status).toBe(204);

    expect((await projectsOf('both')).status).toBe(404);
    expect((await me('both')).status).toBe(200);
    expect((await projectsOf('both', ws2)).status).toBe(200);
  });

  it('invalidates unused reset links from this workspace only', async () => {
    const solo = await linkRows('solo');
    expect(solo.filter((l) => l.workspaceId === ws).every((l) => l.usedAt !== null)).toBe(true);
    expect(solo.find((l) => l.workspaceId === null)!.usedAt).toBeNull();

    const both = await linkRows('both');
    expect(both.find((l) => l.workspaceId === ws)!.usedAt).not.toBeNull();
    expect(both.find((l) => l.workspaceId === ws2)!.usedAt).toBeNull();
  });

  it('refuses to remove the owner with 409 cannot_remove_owner', async () => {
    const res = await del('admin', ids.owner!);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('cannot_remove_owner');
    expect(await isMember('owner')).toBe(true);
  });

  it('lets only the owner remove an admin', async () => {
    expect((await del('admin', ids.admin2!)).status).toBe(403);
    expect(await isMember('admin2')).toBe(true);
    expect((await del('owner', ids.admin2!)).status).toBe(204);
    expect(await isMember('admin2')).toBe(false);
  });

  it('answers 400 use_leave when an admin removes themselves', async () => {
    const res = await del('admin', ids.admin!);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('use_leave');
  });

  it('answers 404 for a non-member and a malformed id, and 403 for a member caller', async () => {
    expect((await del('admin', ids.solo!)).status).toBe(404);
    expect((await del('admin', 'not-a-user')).status).toBe(404);
    expect((await del('leaver', ids.admin!)).status).toBe(403);
  });

  it('calls revocation handlers with the right ids', () => {
    expect(memberRemovedCalls).toContainEqual([ws, ids.solo]);
    expect(memberRemovedCalls).toContainEqual([ws, ids.both]);
    expect(projectRemovedCalls).toContainEqual([ws, withLinks, ids.solo]);
    expect(projectRemovedCalls).toContainEqual([ws, withoutLinks, ids.solo]);
  });

  it('R91: leaving does the same revocation for the person', async () => {
    await putOnProjects('leaver');
    await t.app.get(PasswordResetLinks).issue(ids.leaver!, ws, { userId: ids.admin!, via: 'web' });

    const res = await http().post(`${base()}/leave`).set(as('leaver'));
    expect(res.status).toBe(204);

    expect(await isMember('leaver')).toBe(false);
    expect(await onProjects('leaver')).toHaveLength(0);
    const remove = await t.db.db
      .select()
      .from(projectAccessChecklist)
      .where(
        and(
          eq(projectAccessChecklist.userId, ids.leaver!),
          eq(projectAccessChecklist.kind, 'remove'),
        ),
      );
    expect(remove).toHaveLength(2);
    expect((await linkRows('leaver')).every((l) => l.usedAt !== null)).toBe(true);
    expect((await me('leaver')).status).toBe(401);
    expect(memberRemovedCalls).toContainEqual([ws, ids.leaver]);
    expect(projectRemovedCalls).toContainEqual([ws, withLinks, ids.leaver]);
  });

  it('keeps the owner from leaving with 409', async () => {
    expect((await http().post(`${base()}/leave`).set(as('owner'))).status).toBe(409);
  });

  it('rolls everything back when a step fails after the member row is deleted', async () => {
    await addUser('rollback', [{ ws, role: 'member' }]);
    await putOnProjects('rollback');
    await t.app
      .get(PasswordResetLinks)
      .issue(ids.rollback!, ws, { userId: ids.admin!, via: 'web' });
    await t.db.db
      .update(authSchema.session)
      .set({ activeOrganizationId: ws })
      .where(eq(authSchema.session.userId, ids.rollback!));
    await t.db.db.execute(sql`
      create function fail_session_update() returns trigger language plpgsql as
      $$ begin raise exception 'forced failure'; end $$`);
    await t.db.db.execute(sql`
      create trigger fail_session_update before update on "session"
      for each row execute function fail_session_update()`);
    try {
      const res = await http().post(`${base()}/leave`).set(as('rollback'));
      expect(res.status).toBe(500);
    } finally {
      await t.db.db.execute(sql`drop trigger fail_session_update on "session"`);
      await t.db.db.execute(sql`drop function fail_session_update()`);
    }
    expect(await isMember('rollback')).toBe(true);
    expect(await onProjects('rollback')).toHaveLength(2);
    const stale = await t.db.db
      .select()
      .from(projectAccessChecklist)
      .where(
        and(
          eq(projectAccessChecklist.userId, ids.rollback!),
          eq(projectAccessChecklist.kind, 'remove'),
        ),
      );
    expect(stale).toHaveLength(0);
    expect((await linkRows('rollback')).every((l) => l.usedAt === null)).toBe(true);
  });

  it('clears the leaver active workspace on their sessions', async () => {
    await addUser('active', [
      { ws, role: 'member' },
      { ws: ws2, role: 'member' },
    ]);
    await t.db.db
      .update(authSchema.session)
      .set({ activeOrganizationId: ws })
      .where(eq(authSchema.session.userId, ids.active!));
    expect((await http().post(`${base()}/leave`).set(as('active'))).status).toBe(204);
    const sessions = await t.db.db
      .select()
      .from(authSchema.session)
      .where(eq(authSchema.session.userId, ids.active!));
    expect(sessions.length).toBeGreaterThan(0);
    expect(sessions.every((s) => s.activeOrganizationId === null)).toBe(true);
  });

  it('finishes many concurrent removals without exhausting the pool', async () => {
    const keys = Array.from({ length: 14 }, (_, i) => `bulk${i}`);
    for (const k of keys) await addUser(k, [{ ws, role: 'member' }]);
    const results = await Promise.all(keys.map((k) => del('admin', ids[k]!)));
    expect(results.map((r) => r.status)).toEqual(keys.map(() => 204));
  }, 30_000);

  it('still returns 204 when deleting sessions fails after the member row is gone', async () => {
    await addUser('sessfail', [{ ws, role: 'member' }]);
    const adapter = (await t.auth.$context).internalAdapter;
    const original = adapter.deleteUserSessions;
    adapter.deleteUserSessions = (() => Promise.reject(new Error('boom'))) as typeof original;
    try {
      expect((await del('admin', ids.sessfail!)).status).toBe(204);
    } finally {
      adapter.deleteUserSessions = original;
    }
    expect(await isMember('sessfail')).toBe(false);
  });

  it('refuses a project add that races with the removal of the person', async () => {
    await addUser('racer', [{ ws, role: 'member' }]);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let locked!: () => void;
    const lockedP = new Promise<void>((r) => (locked = r));
    const holder = t.db.db.transaction(async (tx) => {
      await tx
        .select()
        .from(authSchema.member)
        .where(
          and(eq(authSchema.member.userId, ids.racer!), eq(authSchema.member.organizationId, ws)),
        )
        .for('update');
      await tx
        .delete(authSchema.member)
        .where(
          and(eq(authSchema.member.userId, ids.racer!), eq(authSchema.member.organizationId, ws)),
        );
      locked();
      await gate;
    });
    await lockedP;
    const adding = http()
      .post(`${base()}/projects/${withoutLinks}/members`)
      .set(as('owner'))
      .send({ userId: ids.racer })
      .then((r) => r);
    await new Promise((r) => setTimeout(r, 300));
    release();
    await holder;
    const res = await adding;
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('not_a_workspace_member');
    expect(await onProjects('racer')).toHaveLength(0);
  });

  it('re-applies the role rules on the locked row (admin target, admin caller)', async () => {
    await addUser('promoted', [{ ws, role: 'admin' }]);
    expect((await del('admin', ids.promoted!)).status).toBe(403);
  });

  it('gives the pool a connection timeout so exhaustion fails instead of hanging', () => {
    expect(t.db.db.$client.options.connectionTimeoutMillis).toBe(10_000);
  });

  // Enabled in Task 7.2, once MCP tokens (7.1) and the event stream registry (6.4) exist.
  it.todo(
    'after removal, the MCP token gets 401 on the next call and the open SSE stream ends within 2 seconds',
  );
});

describe('RevocationService', () => {
  it('passes ids to handlers and keeps going when one throws', async () => {
    const svc = new RevocationService();
    const seen: string[] = [];
    svc.onMemberRemoved(async () => {
      throw new Error('first fails');
    });
    svc.onMemberRemoved(async (w, u) => {
      seen.push(`m:${w}:${u}`);
    });
    svc.onProjectMemberRemoved(() => {
      throw new Error('sync throw');
    });
    svc.onProjectMemberRemoved(async (w, p, u) => {
      seen.push(`p:${w}:${p}:${u}`);
    });
    await svc.memberRemoved('w1', 'u1');
    await svc.projectMemberRemoved('w1', 'p1', 'u1');
    expect(seen).toEqual(['m:w1:u1', 'p:w1:p1:u1']);
  });
});

describe('RevocationService timeouts', () => {
  it('stops waiting for a handler after 5 seconds and still runs the others', async () => {
    vi.useFakeTimers();
    try {
      const svc = new RevocationService();
      const seen: string[] = [];
      svc.onMemberRemoved(() => new Promise<void>(() => undefined));
      svc.onMemberRemoved(async () => {
        seen.push('ok');
      });
      const done = svc.memberRemoved('w', 'u');
      await vi.advanceTimersByTimeAsync(5000);
      await done;
      expect(seen).toEqual(['ok']);
    } finally {
      vi.useRealTimers();
    }
  });
});
