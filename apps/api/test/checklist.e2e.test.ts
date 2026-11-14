import { authSchema, projectAccessChecklist, projects } from '@briefroom/db';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ConflictException } from '@nestjs/common';
import { ChecklistService } from '../src/projects/checklist.service.ts';
import { createTestApp, makeInstallOwner, type TestApp } from './helpers.ts';

const PASSWORD = 'correct horse battery';

interface Item {
  toolLinkId: string;
  label: string;
  url: string;
  done: boolean;
  doneBy: string | null;
  doneAt: string | null;
}

describe('access checklists', () => {
  let t: TestApp;
  let ws: string;
  let projectId: string;
  let otherProjectId: string;
  let otherLinkId: string;
  const ids: Record<string, string> = {};
  const cookies: Record<string, string> = {};

  const http = () => request(t.app.getHttpServer());
  const base = () => `/api/v1/workspaces/${ws}`;
  const as = (who: string) => ({ cookie: cookies[who]! });
  const checklist = (userId: string, p = projectId) =>
    `${base()}/projects/${p}/members/${userId}/checklist`;
  const get = (who: string, userId: string, kind: string, p = projectId) =>
    http()
      .get(`${checklist(userId, p)}?kind=${kind}`)
      .set(as(who));
  const tick = (who: string, userId: string, body: object, p = projectId) =>
    http().patch(checklist(userId, p)).set(as(who)).send(body);
  const links = async (p = projectId): Promise<{ id: string; label: string }[]> =>
    (await http().get(`${base()}/projects/${p}`).set(as('admin'))).body.toolLinks;

  beforeAll(async () => {
    t = await createTestApp();
    for (const key of ['owner', 'admin', 'member', 'stranger', 'ghost']) {
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
    for (const key of ['admin', 'member', 'ghost']) {
      await t.auth.api.addMember({
        body: { userId: ids[key]!, role: key === 'admin' ? 'admin' : 'member', organizationId: ws },
      });
    }
    const created = await http()
      .post(`${base()}/projects`)
      .set(as('admin'))
      .send({
        name: 'P',
        toolLinks: [
          { label: 'Repo', url: 'https://github.com/acme/p' },
          { label: 'Board', url: 'https://acme.atlassian.net/jira/p' },
        ],
      });
    projectId = created.body.id;
    const other = await http()
      .post(`${base()}/projects`)
      .set(as('admin'))
      .send({ name: 'Q', toolLinks: [{ label: 'Wiki', url: 'https://wiki.example.com/q' }] });
    otherProjectId = other.body.id;
    otherLinkId = (await links(otherProjectId))[0]!.id;
    await http().post(`${base()}/projects/${projectId}/members`).set(as('admin')).send({
      userId: ids.member,
    });
  });

  afterAll(async () => {
    await t.close();
  });

  it('lists one undone add item per tool link', async () => {
    const res = await get('admin', ids.member!, 'add');
    expect(res.status).toBe(200);
    const items: Item[] = res.body;
    expect(items.map((i) => i.label).sort()).toEqual(['Board', 'Repo']);
    expect(items.every((i) => !i.done && i.doneBy === null && i.doneAt === null)).toBe(true);
    expect(items.find((i) => i.label === 'Repo')?.url).toBe('https://github.com/acme/p');
  });

  it('records who ticked an item and when', async () => {
    const [first] = await links();
    const res = await tick('admin', ids.member!, {
      toolLinkId: first!.id,
      kind: 'add',
      done: true,
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ toolLinkId: first!.id, done: true, doneBy: 'admin' });
    expect(typeof res.body.doneAt).toBe('string');

    const items: Item[] = (await get('admin', ids.member!, 'add')).body;
    expect(items.filter((i) => i.done)).toHaveLength(1);
    expect(items.find((i) => i.toolLinkId === first!.id)?.doneBy).toBe('admin');

    const undone = await tick('owner', ids.member!, {
      toolLinkId: first!.id,
      kind: 'add',
      done: false,
    });
    expect(undone.body).toMatchObject({ done: false, doneBy: null, doneAt: null });
  });

  it('keeps the remove checklist reachable after the member leaves the project', async () => {
    const del = await http()
      .delete(`${base()}/projects/${projectId}/members/${ids.member}`)
      .set(as('admin'));
    expect(del.status).toBe(204);
    const res = await get('admin', ids.member!, 'remove');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    expect(res.body.every((i: Item) => !i.done)).toBe(true);
  });

  it('sends the checklist conflict as a code and a message', async () => {
    const service = t.app.get(ChecklistService) as unknown as {
      guard(run: () => Promise<unknown>): Promise<void>;
    };
    const failure = await service
      .guard(() => Promise.reject(Object.assign(new Error('duplicate'), { code: '23505' })))
      .catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(ConflictException);
    expect((failure as ConflictException).getResponse()).toEqual({
      code: 'checklist_conflict',
      message: expect.any(String),
    });
  });

  it('refuses member-role callers with 403', async () => {
    expect((await get('member', ids.member!, 'add')).status).toBe(403);
    const [first] = await links();
    const res = await tick('member', ids.member!, {
      toolLinkId: first!.id,
      kind: 'add',
      done: true,
    });
    expect(res.status).toBe(403);
  });

  it('answers 404 for a tool link of another project', async () => {
    const res = await tick('admin', ids.member!, {
      toolLinkId: otherLinkId,
      kind: 'add',
      done: true,
    });
    expect(res.status).toBe(404);
  });

  it('answers 404 for a user with no workspace membership and no checklist rows', async () => {
    expect((await get('admin', ids.stranger!, 'add')).status).toBe(404);
    expect((await get('admin', 'no-such-user', 'remove')).status).toBe(404);
  });

  it('answers 404 for a project that is not in this workspace or does not exist', async () => {
    expect((await get('admin', ids.member!, 'add', 'not-a-uuid')).status).toBe(404);
    expect(
      (await get('admin', ids.member!, 'add', '00000000-0000-4000-8000-000000000000')).status,
    ).toBe(404);
  });

  it('rejects a missing or bad kind with 400', async () => {
    expect((await get('admin', ids.member!, 'bogus')).status).toBe(400);
  });

  it('resets the checklist when the project tool links are replaced (R73)', async () => {
    const [first] = await links();
    await tick('admin', ids.member!, { toolLinkId: first!.id, kind: 'remove', done: true });
    const patch = await http()
      .patch(`${base()}/projects/${projectId}`)
      .set(as('admin'))
      .send({ toolLinks: [{ label: 'Drive', url: 'https://drive.example.com/p' }] });
    expect(patch.status).toBe(200);

    const stale = await t.db.db
      .select()
      .from(projectAccessChecklist)
      .where(eq(projectAccessChecklist.toolLinkId, first!.id));
    expect(stale).toHaveLength(0);

    const res = await get('admin', ids.member!, 'remove');
    expect(res.status).toBe(200);
    expect(res.body.map((i: Item) => i.label)).toEqual(['Drive']);
    expect(res.body[0].done).toBe(false);
  });

  describe('editing a project keeps unchanged tool links (R76)', () => {
    const REPO = { label: 'Repo', url: 'https://github.com/acme/p' };
    const BOARD = { label: 'Board', url: 'https://acme.atlassian.net/jira/p' };
    const patchLinks = (body: object) =>
      http().patch(`${base()}/projects/${projectId}`).set(as('admin')).send(body);
    const rowsFor = (toolLinkId: string) =>
      t.db.db
        .select()
        .from(projectAccessChecklist)
        .where(eq(projectAccessChecklist.toolLinkId, toolLinkId));

    const linkNamed = async (label: string) => {
      const link = (await links()).find((l) => l.label === label);
      if (!link) throw new Error(`No tool link ${label}`);
      return link;
    };

    beforeAll(async () => {
      expect((await patchLinks({ toolLinks: [REPO, BOARD] })).status).toBe(200);
      const repo = await linkNamed('Repo');
      await tick('admin', ids.member!, { toolLinkId: repo.id, kind: 'add', done: true });
    });

    it('keeps progress when the name changes and the same links are sent', async () => {
      const before = await links();
      const res = await patchLinks({ name: 'Renamed', toolLinks: [REPO, BOARD] });
      expect(res.status).toBe(200);
      expect(res.body.name).toBe('Renamed');
      expect(res.body.toolLinks).toEqual(before);
      const items: Item[] = (await get('admin', ids.member!, 'add')).body;
      expect(items.find((i) => i.label === 'Repo')?.done).toBe(true);
    });

    it('drops only the checklist rows of a removed link', async () => {
      const repo = await linkNamed('Repo');
      const board = await linkNamed('Board');
      expect((await rowsFor(board.id)).length).toBeGreaterThan(0);
      const res = await patchLinks({ toolLinks: [REPO] });
      expect(res.body.toolLinks).toEqual([repo]);
      expect(await rowsFor(board.id)).toHaveLength(0);
      expect((await rowsFor(repo.id)).length).toBeGreaterThan(0);
      const items: Item[] = (await get('admin', ids.member!, 'add')).body;
      expect(items.find((i) => i.label === 'Repo')?.done).toBe(true);
    });

    it('keeps a ticked item when only the label changes (R79)', async () => {
      const repo = await linkNamed('Repo');
      const res = await patchLinks({ toolLinks: [{ ...REPO, label: 'Code' }] });
      expect(res.status).toBe(200);
      expect(res.body.toolLinks).toEqual([{ id: repo.id, label: 'Code', url: REPO.url }]);
      const items: Item[] = (await get('admin', ids.member!, 'add')).body;
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({ toolLinkId: repo.id, label: 'Code', done: true });
      await patchLinks({ toolLinks: [REPO] });
    });

    it('matches links with the same url in order (R79)', async () => {
      const dup = (label: string) => ({ label, url: 'https://dup.example/x' });
      const first = await patchLinks({ toolLinks: [dup('A'), dup('B')] });
      const [a, b] = first.body.toolLinks;
      const second = await patchLinks({ toolLinks: [dup('A2'), dup('B2')] });
      expect(second.body.toolLinks).toEqual([
        { ...a, label: 'A2' },
        { ...b, label: 'B2' },
      ]);
      await patchLinks({ toolLinks: [REPO] });
    });

    it('keeps tool links in the order sent and keeps checklist rows on a reorder (R78)', async () => {
      const res = await patchLinks({ toolLinks: [BOARD, REPO] });
      expect(res.status).toBe(200);
      const before = res.body.toolLinks;
      const labels = (b: { label: string }[]) => b.map((l) => l.label);
      expect(labels(before)).toEqual(['Board', 'Repo']);
      await tick('admin', ids.member!, { toolLinkId: before[0].id, kind: 'add', done: true });

      const flipped = await patchLinks({ toolLinks: [REPO, BOARD] });
      expect(labels(flipped.body.toolLinks)).toEqual(['Repo', 'Board']);
      expect(flipped.body.toolLinks.map((l: { id: string }) => l.id)).toEqual([
        before[1].id,
        before[0].id,
      ]);
      const read = await http().get(`${base()}/projects/${projectId}`).set(as('admin'));
      expect(labels(read.body.toolLinks)).toEqual(['Repo', 'Board']);
      const items: Item[] = (await get('admin', ids.member!, 'add')).body;
      expect(labels(items)).toEqual(['Repo', 'Board']);
      expect(items.find((i) => i.label === 'Board')?.done).toBe(true);
      await patchLinks({ toolLinks: [REPO] });
    });

    it('resets an item whose url changed', async () => {
      const repo = await linkNamed('Repo');
      const res = await patchLinks({ toolLinks: [{ ...REPO, url: 'https://github.com/acme/q' }] });
      expect(res.body.toolLinks[0].id).not.toBe(repo.id);
      expect(await rowsFor(repo.id)).toHaveLength(0);
      const items: Item[] = (await get('admin', ids.member!, 'add')).body;
      expect(items.find((i) => i.label === 'Repo')?.done).toBe(false);
    });
  });

  it('never crosses workspaces for a caller who is in both', async () => {
    const ws2 = (
      await t.auth.api.createOrganization({
        body: { name: 'Other', slug: 'other', userId: ids.owner! },
      })
    ).id;
    await t.auth.api.addMember({
      body: { userId: ids.stranger!, role: 'member', organizationId: ws2 },
    });
    const created = await http()
      .post(`/api/v1/workspaces/${ws2}/projects`)
      .set(as('owner'))
      .send({ name: 'R', toolLinks: [{ label: 'Wiki2', url: 'https://wiki.example.com/r' }] });
    const ws2ProjectId: string = created.body.id;
    const ws2LinkId: string = created.body.toolLinks[0].id;
    const countRows = async () => (await t.db.db.select().from(projectAccessChecklist)).length;
    const before = await countRows();

    const ws2Path = `/api/v1/workspaces/${ws2}/projects/${projectId}/members/${ids.member}/checklist`;
    expect((await http().get(`${ws2Path}?kind=add`).set(as('owner'))).status).toBe(404);

    const patch = await tick('owner', ids.member!, {
      toolLinkId: ws2LinkId,
      kind: 'add',
      done: true,
    });
    expect(patch.status).toBe(404);

    const ws2Only = await http()
      .get(`${checklist(ids.stranger!)}?kind=add`)
      .set(as('owner'));
    expect(ws2Only.status).toBe(404);

    const inWs2 = await http()
      .get(
        `/api/v1/workspaces/${ws2}/projects/${ws2ProjectId}/members/${ids.stranger}/checklist?kind=add`,
      )
      .set(as('owner'));
    expect(inWs2.status).toBe(200);
    expect(await countRows()).toBe(before + 1);
  });

  describe('pending removals (R77)', () => {
    interface Pending {
      userId: string;
      name: string | null;
      email: string | null;
      removedAt: string;
      undone: number;
    }
    const LINKS = [
      { label: 'Repo', url: 'https://github.com/acme/pr' },
      { label: 'Board', url: 'https://acme.atlassian.net/jira/pr' },
    ];
    const members = (p: string) => `${base()}/projects/${p}/members`;
    const pending = (who: string, p: string) =>
      http().get(`${base()}/projects/${p}/pending-removals`).set(as(who));
    const newProject = async (toolLinks: object[] = LINKS): Promise<string> => {
      const res = await http()
        .post(`${base()}/projects`)
        .set(as('admin'))
        .send({ name: 'PR', toolLinks });
      return res.body.id;
    };
    const join = (p: string, who: string) =>
      http().post(members(p)).set(as('admin')).send({ userId: ids[who] });
    const removeRows = async (p: string) =>
      (await t.db.db.select().from(projectAccessChecklist)).filter(
        (r) => r.projectId === p && r.kind === 'remove',
      );

    it('lists a removed member with the number of undone items', async () => {
      const p = await newProject();
      await join(p, 'member');
      expect(
        (
          await http()
            .delete(`${members(p)}/${ids.member}`)
            .set(as('admin'))
        ).status,
      ).toBe(204);
      const res = await pending('admin', p);
      expect(res.status).toBe(200);
      expect(res.body).toEqual([
        {
          userId: ids.member,
          name: 'member',
          email: 'member@example.com',
          removedAt: expect.any(String),
          undone: 2,
        },
      ]);
      const rows = await removeRows(p);
      expect(rows).toHaveLength(2);
      expect(rows.every((r) => r.createdBy === ids.admin && !r.done)).toBe(true);
    });

    it('lists a member who leaves on their own', async () => {
      const p = await newProject();
      await join(p, 'member');
      expect(
        (
          await http()
            .post(`${members(p)}/leave`)
            .set(as('member'))
        ).status,
      ).toBe(204);
      const res = await pending('admin', p);
      expect(res.body).toHaveLength(1);
      expect(res.body[0]).toMatchObject({ userId: ids.member, undone: 2 });
      expect((await removeRows(p)).every((r) => r.createdBy === ids.member)).toBe(true);
    });

    it('counts down as items are ticked and drops the user at zero', async () => {
      const p = await newProject();
      await join(p, 'member');
      await http()
        .delete(`${members(p)}/${ids.member}`)
        .set(as('admin'));
      const [first, second] = await links(p);
      await tick('admin', ids.member!, { toolLinkId: first!.id, kind: 'remove', done: true }, p);
      expect((await pending('admin', p)).body[0].undone).toBe(1);
      await tick('admin', ids.member!, { toolLinkId: second!.id, kind: 'remove', done: true }, p);
      expect((await pending('admin', p)).body).toEqual([]);
    });

    it('lists newest removals first and shows no name for a deleted account', async () => {
      const p = await newProject();
      await join(p, 'member');
      await join(p, 'ghost');
      await http()
        .delete(`${members(p)}/${ids.member}`)
        .set(as('admin'));
      await http()
        .delete(`${members(p)}/${ids.ghost}`)
        .set(as('admin'));
      await t.db.db.delete(authSchema.user).where(eq(authSchema.user.id, ids.ghost!));
      const res = await pending('owner', p);
      expect(res.body.map((r: Pending) => r.userId)).toEqual([ids.ghost, ids.member]);
      expect(res.body[0]).toMatchObject({ name: null, email: null, undone: 2 });
    });

    it('does not list someone who is on the project again', async () => {
      const p = await newProject();
      await join(p, 'member');
      await http()
        .delete(`${members(p)}/${ids.member}`)
        .set(as('admin'));
      expect((await pending('admin', p)).body).toHaveLength(1);
      await join(p, 'member');
      expect((await pending('admin', p)).body).toEqual([]);
    });

    it('shows a person as pending again after remove, tick all, re-add and remove (R80)', async () => {
      const p = await newProject();
      await join(p, 'member');
      await http()
        .delete(`${members(p)}/${ids.member}`)
        .set(as('admin'));
      for (const l of await links(p)) {
        await tick('admin', ids.member!, { toolLinkId: l.id, kind: 'remove', done: true }, p);
      }
      expect((await pending('admin', p)).body).toEqual([]);
      await join(p, 'member');
      await http()
        .delete(`${members(p)}/${ids.member}`)
        .set(as('admin'));
      const res = await pending('admin', p);
      expect(res.body).toHaveLength(1);
      expect(res.body[0]).toMatchObject({ userId: ids.member, undone: 2 });
      const rows = await removeRows(p);
      expect(rows.every((r) => r.updatedBy === ids.admin)).toBe(true);
    });

    it('resets the add checklist on each add (R80)', async () => {
      const p = await newProject();
      await join(p, 'member');
      const [first] = await links(p);
      await tick('admin', ids.member!, { toolLinkId: first!.id, kind: 'add', done: true }, p);
      expect(((await get('admin', ids.member!, 'add', p)).body as Item[]).some((i) => i.done)).toBe(
        true,
      );
      await http()
        .delete(`${members(p)}/${ids.member}`)
        .set(as('admin'));
      await join(p, 'member');
      const items: Item[] = (await get('admin', ids.member!, 'add', p)).body;
      expect(items).toHaveLength(2);
      expect(items.every((i) => !i.done)).toBe(true);
    });

    it('dates a pending removal by the latest removal and sorts on it', async () => {
      const p = await newProject();
      await join(p, 'member');
      await join(p, 'admin');
      await http()
        .delete(`${members(p)}/${ids.member}`)
        .set(as('owner'));
      await http()
        .delete(`${members(p)}/${ids.admin}`)
        .set(as('owner'));
      const first = (await pending('owner', p)).body as Pending[];
      const firstMember = first.find((r) => r.userId === ids.member)!.removedAt;
      await join(p, 'member');
      await new Promise((r) => setTimeout(r, 25));
      await http()
        .delete(`${members(p)}/${ids.member}`)
        .set(as('owner'));
      const res = (await pending('owner', p)).body as Pending[];
      expect(res.map((r) => r.userId)).toEqual([ids.member, ids.admin]);
      expect(Date.parse(res[0]!.removedAt)).toBeGreaterThan(Date.parse(firstMember));
    });

    it('waits for a concurrent project edit instead of racing it on removal', async () => {
      const p = await newProject();
      await join(p, 'member');
      let release!: () => void;
      const held = new Promise<void>((r) => (release = r));
      let locked!: () => void;
      const hasLock = new Promise<void>((r) => (locked = r));
      const editor = t.db.db.transaction(async (tx) => {
        await tx.select().from(projects).where(eq(projects.id, p)).for('update');
        locked();
        await held;
      });
      await hasLock;
      let done = false;
      const removal = http()
        .delete(`${members(p)}/${ids.member}`)
        .set(as('admin'))
        .then((res) => {
          done = true;
          return res;
        });
      await new Promise((r) => setTimeout(r, 300));
      expect(done).toBe(false);
      release();
      await editor;
      expect((await removal).status).toBe(204);
    });

    it('creates nothing when the project has no tool links', async () => {
      const p = await newProject([]);
      await join(p, 'member');
      await http()
        .delete(`${members(p)}/${ids.member}`)
        .set(as('admin'));
      expect(await removeRows(p)).toHaveLength(0);
      expect((await pending('admin', p)).body).toEqual([]);
    });

    it('is admin only and answers 404 for an unknown or malformed project', async () => {
      const p = await newProject();
      expect((await pending('member', p)).status).toBe(403);
      expect((await pending('admin', 'not-a-uuid')).status).toBe(404);
      expect((await pending('admin', '00000000-0000-4000-8000-000000000000')).status).toBe(404);
    });
  });
});
