import { authSchema } from '@briefroom/db';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, makeInstallOwner, type TestApp } from './helpers.ts';

const PASSWORD = 'correct horse battery';
const TRUSTED = 'http://localhost:4300';

describe('origin check on mutation routes', () => {
  let t: TestApp;
  let workspaceId: string;
  const ids: Record<string, string> = {};
  const cookies: Record<string, string> = {};

  const http = () => request(t.app.getHttpServer());
  const leave = (who: string) =>
    http().post(`/api/v1/workspaces/${workspaceId}/leave`).set({ cookie: cookies[who]! });
  const stillMember = async (who: string) =>
    (await t.db.db.select().from(authSchema.member).where(eq(authSchema.member.userId, ids[who]!)))
      .length === 1;

  beforeAll(async () => {
    t = await createTestApp();
    for (const key of ['owner', 'm1', 'm2', 'm3', 'm4']) {
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
    workspaceId = (
      await t.auth.api.createOrganization({
        body: { name: 'Acme', slug: 'acme', userId: ids.owner! },
      })
    ).id;
    for (const key of ['m1', 'm2', 'm3', 'm4']) {
      await t.auth.api.addMember({
        body: { userId: ids[key]!, role: 'member', organizationId: workspaceId },
      });
    }
  });

  afterAll(async () => {
    await t.close();
  });

  it('refuses a cross-origin POST with 403 and does not run it', async () => {
    const res = await leave('m1').set('Origin', 'http://evil.example');
    expect(res.status).toBe(403);
    expect(await stillMember('m1')).toBe(true);
  });

  it('refuses a POST the browser marks cross-site or same-site', async () => {
    for (const site of ['cross-site', 'same-site']) {
      const res = await leave('m1').set('Sec-Fetch-Site', site);
      expect(res.status).toBe(403);
    }
    expect(await stillMember('m1')).toBe(true);
  });

  it('refuses an Origin of "null"', async () => {
    expect((await leave('m1').set('Origin', 'null')).status).toBe(403);
  });

  it('lets the trusted origin through, also when the browser says same-origin', async () => {
    const res = await leave('m2').set({ Origin: TRUSTED, 'Sec-Fetch-Site': 'same-origin' });
    expect(res.status).toBeLessThan(300);
    expect(await stillMember('m2')).toBe(false);
  });

  it('lets a request with no Origin and no Sec-Fetch-Site through (CLI, server to server)', async () => {
    const res = await leave('m3');
    expect(res.status).toBeLessThan(300);
    expect(await stillMember('m3')).toBe(false);
  });

  it('does not check safe methods', async () => {
    const res = await http()
      .get('/api/v1/workspaces')
      .set({ cookie: cookies.m4!, Origin: 'http://evil.example' });
    expect(res.status).toBe(200);
  });

  it('does not parse a urlencoded body on our routes', async () => {
    const res = await http()
      .post('/api/v1/workspaces')
      .set({ cookie: cookies.owner! })
      .type('form')
      .send({ name: 'From a form' });
    expect(res.status).toBe(400);
    const names = (await t.db.db.select().from(authSchema.organization)).map((o) => o.name);
    expect(names).not.toContain('From a form');
  });
});
