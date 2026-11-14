import { projectMembers, projectRemotes, projects, projectToolLinks } from '@briefroom/db';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Scope } from '../src/access/scope.ts';
import { ProjectsService } from '../src/projects/projects.service.ts';
import { createTestApp, makeInstallOwner, type TestApp } from './helpers.ts';

const PASSWORD = 'correct horse battery';

describe('projects', () => {
  let t: TestApp;
  let ws: string;
  let ws2: string;
  const ids: Record<string, string> = {};
  const cookies: Record<string, string> = {};

  const http = () => request(t.app.getHttpServer());
  const base = (w = ws) => `/api/v1/workspaces/${w}`;
  const as = (who: string) => ({ cookie: cookies[who]! });
  const create = (who: string, body: object, w = ws) =>
    http()
      .post(`${base(w)}/projects`)
      .set(as(who))
      .send(body);
  const setting = (value: boolean) =>
    http().patch(`${base()}/settings`).set(as('owner')).send({ membersCanCreateProjects: value });
  const projectCount = async () => (await t.db.db.select().from(projects)).length;

  beforeAll(async () => {
    t = await createTestApp();
    for (const key of ['owner', 'admin', 'member', 'outsider']) {
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
  });

  afterAll(async () => {
    await t.close();
  });

  describe('create and read', () => {
    it('creates a project with remotes and tool links and adds the creator', async () => {
      const res = await create('admin', {
        name: 'Briefroom',
        client: 'Self',
        ticketKey: 'BRIEF',
        repoRemotes: ['git@github.com:Marko/Briefroom.git'],
        toolLinks: [{ label: 'Board', url: 'https://example.atlassian.net/browse/BRIEF' }],
      });
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        name: 'Briefroom',
        status: 'active',
        isClientWork: false,
        repoRemotes: [
          {
            original: 'git@github.com:Marko/Briefroom.git',
            normalized: 'github.com/marko/briefroom',
          },
        ],
        toolLinks: [{ label: 'Board', url: 'https://example.atlassian.net/browse/BRIEF' }],
      });
      const members = await t.db.db
        .select()
        .from(projectMembers)
        .where(eq(projectMembers.projectId, res.body.id));
      expect(members).toHaveLength(1);
      expect(members[0]).toMatchObject({
        userId: ids.admin,
        workspaceId: ws,
        createdBy: ids.admin,
      });

      const read = await http().get(`${base()}/projects/${res.body.id}`).set(as('admin'));
      expect(read.status).toBe(200);
      expect(read.body.repoRemotes).toHaveLength(1);
      const list = await http().get(`${base()}/projects`).set(as('owner'));
      expect(list.body.map((p: { id: string }) => p.id)).toContain(res.body.id);
    });

    it('returns 404 for an unknown, malformed or other-workspace project id', async () => {
      const other = await create('owner', { name: 'Elsewhere' }, ws2);
      expect(other.status).toBe(201);
      const ids404 = ['11111111-1111-4111-8111-111111111111', 'nope', other.body.id];
      for (const id of ids404) {
        const res = await http().get(`${base()}/projects/${id}`).set(as('admin'));
        expect(res.status).toBe(404);
        const del = await http().delete(`${base()}/projects/${id}`).set(as('admin'));
        expect(del.status).toBe(404);
      }
      const list = await http().get(`${base()}/projects`).set(as('admin'));
      expect(list.body.map((p: { id: string }) => p.id)).not.toContain(other.body.id);
    });

    it('hides projects from a member and an outsider', async () => {
      const made = await create('admin', { name: 'Hidden' });
      const list = await http().get(`${base()}/projects`).set(as('member'));
      expect(list.status).toBe(200);
      expect(list.body).toEqual([]);
      const one = await http().get(`${base()}/projects/${made.body.id}`).set(as('member'));
      expect(one.status).toBe(404);
      const out = await http().get(`${base()}/projects`).set(as('outsider'));
      expect(out.status).toBe(404);
    });
  });

  describe('who may create', () => {
    it('refuses a member until the setting is on, then adds them to the project', async () => {
      expect((await create('member', { name: 'Mine' })).status).toBe(403);
      expect((await setting(true)).status).toBe(200);
      const res = await create('member', {
        name: 'Mine',
        repoRemotes: ['https://github.com/mine/repo'],
        toolLinks: [{ label: 'Docs', url: 'https://docs.example' }],
      });
      expect(res.status).toBe(201);
      expect(res.body.repoRemotes).toHaveLength(1);
      expect(res.body.toolLinks).toEqual([expect.objectContaining({ label: 'Docs' })]);
      const rows = await t.db.db
        .select()
        .from(projectMembers)
        .where(eq(projectMembers.projectId, res.body.id));
      expect(rows.map((r) => r.userId)).toEqual([ids.member]);
      expect((await setting(false)).status).toBe(200);
      expect((await create('member', { name: 'Mine again' })).status).toBe(403);
    });

    it('returns tool links in the order they were sent', async () => {
      const links = [
        { label: 'Zeta', url: 'https://z.example' },
        { label: 'Alpha', url: 'https://a.example' },
        { label: 'Mid', url: 'https://m.example' },
      ];
      const res = await create('admin', { name: 'Ordered', toolLinks: links });
      expect(res.status).toBe(201);
      const labels = (b: { toolLinks: { label: string }[] }) => b.toolLinks.map((l) => l.label);
      expect(labels(res.body)).toEqual(['Zeta', 'Alpha', 'Mid']);
      const read = await http().get(`${base()}/projects/${res.body.id}`).set(as('admin'));
      expect(labels(read.body)).toEqual(['Zeta', 'Alpha', 'Mid']);
    });

    it('refuses an outsider with 404', async () => {
      expect((await create('outsider', { name: 'No' })).status).toBe(404);
    });
  });

  describe('input validation', () => {
    it.each([
      ['javascript:alert(1)'],
      ['data:text/html,<script>alert(1)</script>'],
      ['ftp://example.com/x'],
      ['not a url'],
    ])('refuses the tool link %s with 400', async (url) => {
      const before = await projectCount();
      const res = await create('admin', { name: 'Bad link', toolLinks: [{ label: 'x', url }] });
      expect(res.status).toBe(400);
      expect(await projectCount()).toBe(before);
    });

    it.each([
      ['empty name', { name: '' }],
      ['long name', { name: 'x'.repeat(81) }],
      ['ticket key', { name: 'A', ticketKey: 'brief' }],
      ['status', { name: 'A', status: 'archived' }],
      [
        'label too long',
        { name: 'A', toolLinks: [{ label: 'x'.repeat(41), url: 'https://a.io' }] },
      ],
      ['empty label', { name: 'A', toolLinks: [{ label: '', url: 'https://a.io' }] }],
      [
        'too many remotes',
        { name: 'A', repoRemotes: Array.from({ length: 11 }, (_, i) => `h/o/r${i}`) },
      ],
      ['bad remote', { name: 'A', repoRemotes: ['not a url'] }],
      ['blank remote', { name: 'A', repoRemotes: ['  '] }],
    ])('refuses %s with 400', async (_label, body) => {
      expect((await create('admin', body)).status).toBe(400);
    });
  });

  describe('repo remotes', () => {
    it('refuses a second project with the same remote in another spelling (409)', async () => {
      const first = await create('admin', {
        name: 'Dup A',
        repoRemotes: ['git@github.com:Dup/Repo.git'],
      });
      expect(first.status).toBe(201);
      const before = await projectCount();
      const second = await create('admin', {
        name: 'Dup B',
        repoRemotes: ['https://github.com/dup/repo'],
      });
      expect(second.status).toBe(409);
      expect(second.body.code).toBe('remote_already_registered');
      expect(second.body.message).toBe('This repo remote is already registered in this workspace.');
      expect(JSON.stringify(second.body)).not.toContain('Dup A');
      expect(await projectCount()).toBe(before);
    });

    it('refuses the same remote twice in one request (400)', async () => {
      const res = await create('admin', {
        name: 'Twice',
        repoRemotes: ['https://github.com/tw/ice', 'git@github.com:TW/ice.git'],
      });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('duplicate_remote_in_request');
    });

    it('collides a dot-segment spelling with the repo it resolves to (409)', async () => {
      const res = await create('admin', {
        name: 'Dot dup',
        repoRemotes: ['https://github.com/dup/x/../repo'],
      });
      expect(res.status).toBe(409);
    });

    it.each([['git@github.com:./dup/repo.git'], ['git@github.com:dup/%2e%2e/dup/repo.git']])(
      'refuses the dot-segment remote %s with 400',
      async (remote) => {
        const res = await create('admin', { name: 'Dot', repoRemotes: [remote] });
        expect(res.status).toBe(400);
      },
    );

    it('allows the same remote in another workspace', async () => {
      const res = await create(
        'owner',
        { name: 'Dup elsewhere', repoRemotes: ['https://github.com/dup/repo'] },
        ws2,
      );
      expect(res.status).toBe(201);
    });

    it('strips credentials from the stored and returned original remote', async () => {
      const res = await create('admin', {
        name: 'Creds',
        repoRemotes: ['https://user:tok@github.com/cr/eds.git', 'git@github.com:cr/other.git'],
      });
      expect(res.status).toBe(201);
      const originals = res.body.repoRemotes.map((r: { original: string }) => r.original).sort();
      expect(originals).toEqual(['git@github.com:cr/other.git', 'https://github.com/cr/eds.git']);
      const rows = await t.db.db
        .select()
        .from(projectRemotes)
        .where(eq(projectRemotes.projectId, res.body.id));
      expect(JSON.stringify(rows)).not.toContain('tok');
    });

    it('treats empty client and summary as null', async () => {
      const res = await create('admin', { name: 'Blank', client: '', summary: '  ' });
      expect(res.body).toMatchObject({ client: null, summary: null });
      const patched = await http()
        .patch(`${base()}/projects/${res.body.id}`)
        .set(as('admin'))
        .send({ client: 'X', summary: 'Y' });
      expect(patched.body).toMatchObject({ client: 'X', summary: 'Y' });
      const cleared = await http()
        .patch(`${base()}/projects/${res.body.id}`)
        .set(as('admin'))
        .send({ client: '', summary: '' });
      expect(cleared.body).toMatchObject({ client: null, summary: null });
    });

    it('returns null from findByRemote for an invalid remote', async () => {
      const service = t.app.get(ProjectsService);
      const scope: Scope = {
        userId: ids.admin!,
        workspaceId: ws,
        role: 'admin',
        visibleProjectIds: 'all',
        permissions: new Set(),
        actor: { userId: ids.admin!, via: 'mcp' },
      };
      for (const bad of ['', 'not a url', 'https://github.com']) {
        expect(await service.findByRemote(scope, bad)).toBeNull();
      }
    });

    it('finds a project by remote only when it is visible', async () => {
      const service = t.app.get(ProjectsService);
      const scope = (userId: string, visible: Scope['visibleProjectIds']): Scope => ({
        userId,
        workspaceId: ws,
        role: 'admin',
        visibleProjectIds: visible,
        permissions: new Set(),
        actor: { userId, via: 'web' },
      });
      const found = await service.findByRemote(scope(ids.admin!, 'all'), 'git@github.com:dup/REPO');
      expect(found?.name).toBe('Dup A');
      expect(
        await service.findByRemote(scope(ids.member!, []), 'https://github.com/dup/repo'),
      ).toBeNull();
      expect(
        await service.findByRemote(scope(ids.admin!, 'all'), 'https://github.com/none/none'),
      ).toBeNull();
      const elsewhere = { ...scope(ids.owner!, 'all'), workspaceId: ws2 };
      expect((await service.findByRemote(elsewhere, 'https://github.com/dup/repo'))?.name).toBe(
        'Dup elsewhere',
      );
    });
  });

  describe('update and delete', () => {
    let id: string;
    beforeAll(async () => {
      const res = await create('admin', {
        name: 'Patch me',
        repoRemotes: ['https://github.com/p/one'],
        toolLinks: [{ label: 'One', url: 'https://one.example' }],
      });
      id = res.body.id;
    });
    const patch = (who: string, body: object) =>
      http().patch(`${base()}/projects/${id}`).set(as(who)).send(body);

    it('is admin only', async () => {
      expect((await patch('member', { name: 'x' })).status).toBe(403);
      expect((await http().delete(`${base()}/projects/${id}`).set(as('member'))).status).toBe(403);
    });

    it('updates fields and leaves the lists alone when they are not given', async () => {
      const res = await patch('admin', { name: 'Patched', status: 'paused' });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ name: 'Patched', status: 'paused' });
      expect(res.body.repoRemotes).toHaveLength(1);
      expect(res.body.toolLinks).toHaveLength(1);
    });

    it('replaces remotes and tool links wholesale', async () => {
      const res = await patch('admin', {
        repoRemotes: ['https://github.com/p/two', 'https://github.com/p/three.git'],
        toolLinks: [],
      });
      expect(res.status).toBe(200);
      expect(res.body.repoRemotes.map((r: { normalized: string }) => r.normalized).sort()).toEqual([
        'github.com/p/three',
        'github.com/p/two',
      ]);
      expect(res.body.toolLinks).toEqual([]);
      const old = await t.db.db
        .select()
        .from(projectRemotes)
        .where(eq(projectRemotes.normalized, 'github.com/p/one'));
      expect(old).toEqual([]);
    });

    it('keeps ids of unchanged links and remotes, and adds new ones', async () => {
      const first = await patch('admin', {
        repoRemotes: ['git@github.com:acme/keep.git'],
        toolLinks: [{ label: 'One', url: 'https://one.example' }],
      });
      const keptLink = first.body.toolLinks[0];
      const res = await patch('admin', {
        repoRemotes: ['git@github.com:acme/keep.git', 'git@github.com:acme/new.git'],
        toolLinks: [
          { label: 'One', url: 'https://one.example' },
          { label: 'Two', url: 'https://two.example' },
        ],
      });
      expect(res.status).toBe(200);
      expect(res.body.toolLinks).toHaveLength(2);
      expect(res.body.toolLinks[0]).toEqual(keptLink);
      expect(res.body.repoRemotes.map((r: { original: string }) => r.original)).toEqual([
        'git@github.com:acme/keep.git',
        'git@github.com:acme/new.git',
      ]);
    });

    it('keeps the row id of a re-spelled remote and updates its original', async () => {
      const first = await patch('admin', { repoRemotes: ['https://github.com/acme/spell.git'] });
      expect(first.status).toBe(200);
      const [before] = await t.db.db
        .select()
        .from(projectRemotes)
        .where(eq(projectRemotes.normalized, 'github.com/acme/spell'));
      const res = await patch('admin', { repoRemotes: ['git@github.com:Acme/Spell.git'] });
      expect(res.status).toBe(200);
      expect(res.body.repoRemotes).toEqual([
        { original: 'git@github.com:Acme/Spell.git', normalized: 'github.com/acme/spell' },
      ]);
      const [after] = await t.db.db
        .select()
        .from(projectRemotes)
        .where(eq(projectRemotes.normalized, 'github.com/acme/spell'));
      expect(after!.id).toBe(before!.id);
      expect(after!.original).toBe('git@github.com:Acme/Spell.git');
      await patch('admin', {
        repoRemotes: ['git@github.com:acme/keep.git', 'git@github.com:acme/new.git'],
      });
    });

    it('refuses the same remote twice in one patch (400)', async () => {
      const res = await patch('admin', {
        repoRemotes: ['https://github.com/tw/ice', 'git@github.com:TW/ice.git'],
      });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('duplicate_remote_in_request');
    });

    it('serialises concurrent patches of one project', async () => {
      const bodies = [1, 2, 3, 4].map((n) => ({
        toolLinks: [
          { label: `L${n}a`, url: `https://c${n}.example/a` },
          { label: `L${n}b`, url: `https://c${n}.example/b` },
        ],
      }));
      const results = await Promise.all(bodies.map((b) => patch('admin', b)));
      expect(results.map((r) => r.status)).toEqual([200, 200, 200, 200]);
      const read = await http().get(`${base()}/projects/${id}`).set(as('admin'));
      expect(read.body.toolLinks).toHaveLength(2);
      const urls = read.body.toolLinks.map((l: { url: string }) => new URL(l.url).host);
      expect(new Set(urls).size).toBe(1);
    });

    it('keeps the old lists when the new ones conflict (409) or are invalid (400)', async () => {
      const conflict = await patch('admin', {
        name: 'Should not stick',
        repoRemotes: ['git@github.com:Dup/Repo.git'],
      });
      expect(conflict.status).toBe(409);
      const link = await patch('admin', {
        toolLinks: [{ label: 'x', url: 'javascript:alert(1)' }],
      });
      expect(link.status).toBe(400);
      const read = await http().get(`${base()}/projects/${id}`).set(as('admin'));
      expect(read.body.name).toBe('Patched');
      expect(read.body.repoRemotes).toHaveLength(2);
    });

    it('returns 404 when patching a project of another workspace', async () => {
      const other = await create('owner', { name: 'Not yours' }, ws2);
      const res = await http()
        .patch(`${base()}/projects/${other.body.id}`)
        .set(as('admin'))
        .send({ name: 'x' });
      expect(res.status).toBe(404);
    });

    it('deletes a project with its remotes, tool links and members', async () => {
      await patch('admin', { toolLinks: [{ label: 'Keep', url: 'https://keep.example' }] });
      const res = await http().delete(`${base()}/projects/${id}`).set(as('admin'));
      expect(res.status).toBe(204);
      for (const table of [projectRemotes, projectToolLinks, projectMembers]) {
        const rows = await t.db.db.select().from(table).where(eq(table.projectId, id));
        expect(rows).toEqual([]);
      }
      expect((await http().get(`${base()}/projects/${id}`).set(as('admin'))).status).toBe(404);
      expect((await http().delete(`${base()}/projects/${id}`).set(as('admin'))).status).toBe(404);
    });
  });

  describe('workspace settings', () => {
    it('defaults to false and any member may read', async () => {
      const res = await http()
        .get(`${base(ws2)}/settings`)
        .set(as('owner'));
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ membersCanCreateProjects: false });
      const member = await http().get(`${base()}/settings`).set(as('member'));
      expect(member.status).toBe(200);
      expect((await http().get(`${base()}/settings`).set(as('outsider'))).status).toBe(404);
    });

    it('lets an admin upsert and refuses a member', async () => {
      const on = await http()
        .patch(`${base()}/settings`)
        .set(as('admin'))
        .send({ membersCanCreateProjects: true });
      expect(on.body).toEqual({ membersCanCreateProjects: true });
      const off = await http()
        .patch(`${base()}/settings`)
        .set(as('admin'))
        .send({ membersCanCreateProjects: false });
      expect(off.body).toEqual({ membersCanCreateProjects: false });
      const member = await http()
        .patch(`${base()}/settings`)
        .set(as('member'))
        .send({ membersCanCreateProjects: true });
      expect(member.status).toBe(403);
      const bad = await http()
        .patch(`${base()}/settings`)
        .set(as('admin'))
        .send({ membersCanCreateProjects: 'yes' });
      expect(bad.status).toBe(400);
    });
  });
});
