import { projectAccessChecklist } from '@briefroom/db';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
    for (const key of ['owner', 'admin', 'member', 'stranger']) {
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
    for (const key of ['admin', 'member']) {
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
});
