import { Controller, Get } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RequireRole } from '../src/access/require-role.decorator.ts';
import { createTestApp, makeInstallOwner, type TestApp } from './helpers.ts';

const PASSWORD = 'correct horse battery';
const handlerRuns = { orphan: 0 };

// Deliberately no @UseGuards: the global guard alone must protect these.
@Controller('v1/workspaces/:workspaceId/probe')
class ProbeController {
  @Get()
  read() {
    return { ok: true };
  }

  @RequireRole('admin')
  @Get('admin')
  admin() {
    return { ok: true };
  }
}

@Controller('v1/probe-without-workspace')
class OrphanController {
  @RequireRole('admin')
  @Get()
  run() {
    handlerRuns.orphan++;
    return { ok: true };
  }
}

describe('global workspace scope guard', () => {
  let t: TestApp;
  const ids: Record<string, string> = {};
  const cookies: Record<string, string> = {};
  let workspaceId: string;

  const http = () => request(t.app.getHttpServer());

  beforeAll(async () => {
    t = await createTestApp({}, [ProbeController, OrphanController]);
    for (const key of ['owner', 'member', 'outsider']) {
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
    const ws = await t.auth.api.createOrganization({
      body: { name: 'Acme', slug: 'acme', userId: ids.owner! },
    });
    workspaceId = ws.id;
    await t.auth.api.addMember({
      body: { userId: ids.member!, role: 'member', organizationId: workspaceId },
    });
  });

  afterAll(async () => {
    await t.close();
  });

  it('returns 404 for a non-member on a controller that opts into nothing', async () => {
    const res = await http()
      .get(`/api/v1/workspaces/${workspaceId}/probe`)
      .set({ cookie: cookies.outsider! });
    expect(res.status).toBe(404);
  });

  it('lets a member through a plain route', async () => {
    const res = await http()
      .get(`/api/v1/workspaces/${workspaceId}/probe`)
      .set({ cookie: cookies.member! });
    expect(res.status).toBe(200);
  });

  it('returns 403 for a member and 404 for a non-member on an @RequireRole(admin) route', async () => {
    const member = await http()
      .get(`/api/v1/workspaces/${workspaceId}/probe/admin`)
      .set({ cookie: cookies.member! });
    const outsider = await http()
      .get(`/api/v1/workspaces/${workspaceId}/probe/admin`)
      .set({ cookie: cookies.outsider! });
    expect(member.status).toBe(403);
    expect(outsider.status).toBe(404);
    const owner = await http()
      .get(`/api/v1/workspaces/${workspaceId}/probe/admin`)
      .set({ cookie: cookies.owner! });
    expect(owner.status).toBe(200);
  });

  it('requires a session', async () => {
    const res = await http().get(`/api/v1/workspaces/${workspaceId}/probe`);
    expect(res.status).toBe(401);
  });

  it('fails closed on @RequireRole without a workspaceId param and never runs the handler', async () => {
    const res = await http().get('/api/v1/probe-without-workspace').set({ cookie: cookies.owner! });
    expect(res.status).toBe(500);
    expect(handlerRuns.orphan).toBe(0);
  });
});
