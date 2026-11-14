import { SetupResponse, VersionResponse } from '@briefroom/contracts';
import { authSchema, install } from '@briefroom/db';
import { APIError } from 'better-auth/api';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { InstallService } from '../src/install/install.service.ts';
import { createTestApp, type TestApp } from './helpers.ts';

const PASSWORD = 'correct horse battery';

describe('install and first-run setup', () => {
  let t: TestApp;
  let installs: InstallService;
  let code: string;

  beforeAll(async () => {
    t = await createTestApp();
    installs = t.app.get(InstallService);
    const ensured = await installs.ensureInstall();
    if (!ensured.setupCode) throw new Error('expected a setup code on a fresh install');
    code = ensured.setupCode;
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
  const row = async () => (await t.db.db.select().from(install))[0]!;
  const users = () => t.db.db.select().from(authSchema.user);
  const orgs = () => t.db.db.select().from(authSchema.organization);

  it('stores only a hash of the code and one install row', async () => {
    const rows = await t.db.db.select().from(install);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.setupCodeHash).toMatch(/^[0-9a-f]{64}$/);
    expect(rows[0]!.createdBy).toBe('system');
    expect(rows[0]!.updatedBy).toBe('system');
    expect(rows[0]!.ownerUserId).toBeNull();
  });

  it('GET /api/v1/setup says setup is needed', async () => {
    const res = await http().get('/api/v1/setup');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ needsSetup: true });
  });

  it('GET /api/version returns the install id', async () => {
    const res = await http().get('/api/version');
    expect(VersionResponse.parse(res.body).installId).toBe((await row()).id);
  });

  it('rejects an invalid body with 400 and does not count an attempt', async () => {
    const before = (await row()).failedSetupAttempts;
    const res = await http()
      .post('/api/v1/setup')
      .send(body({ password: 'short' }));
    expect(res.status).toBe(400);
    expect((await row()).failedSetupAttempts).toBe(before);
  });

  it('a wrong code returns 401 and increments failed_setup_attempts', async () => {
    const res = await http()
      .post('/api/v1/setup')
      .send(body({ code: 'AAAA-AAAA' }));
    expect(res.status).toBe(401);
    expect((await row()).failedSetupAttempts).toBe(1);
    expect(await users()).toHaveLength(0);
  });

  it('returns 429 after 10 wrong codes, even with the right code, until the next boot', async () => {
    for (let i = 0; i < 9; i++) {
      const res = await http()
        .post('/api/v1/setup')
        .send(body({ code: 'AAAA-AAAA' }));
      expect(res.status).toBe(401);
    }
    expect((await row()).failedSetupAttempts).toBe(10);
    const locked = await http().post('/api/v1/setup').send(body());
    expect(locked.status).toBe(429);

    const next = await installs.ensureInstall();
    expect(next.setupCode).not.toBeNull();
    expect(next.setupCode).not.toBe(code);
    expect((await row()).failedSetupAttempts).toBe(0);
    const stale = await http().post('/api/v1/setup').send(body());
    expect(stale.status).toBe(401);
    code = next.setupCode!;
  });

  it('the right code returns 201, signs in, and creates the owner and a personal workspace', async () => {
    const res = await http().post('/api/v1/setup').send(body());
    expect(res.status).toBe(201);
    const { userId, workspaceId } = SetupResponse.parse(res.body);
    expect(await installs.isInstallOwner(userId)).toBe(true);
    expect(await installs.isInstallOwner('someone-else')).toBe(false);
    expect((await row()).setupCodeHash).toBeNull();

    const organizations = await orgs();
    expect(organizations).toHaveLength(1);
    expect(organizations[0]!.id).toBe(workspaceId);
    expect(organizations[0]!.name).toBe("Ada's workspace");
    const members = await t.db.db.select().from(authSchema.member);
    expect(members).toHaveLength(1);
    expect(members[0]).toMatchObject({ userId, organizationId: workspaceId, role: 'owner' });
    expect((await users())[0]!.role).not.toBe('admin');

    const cookies = res.headers['set-cookie'] as unknown as string[];
    expect(cookies.join(';')).toContain('better-auth.session_token=');
    const session = await http()
      .get('/api/auth/get-session')
      .set('cookie', cookies.map((c) => c.split(';')[0]).join('; '));
    expect(session.body.user.email).toBe('ada@example.com');
  });

  it('a second setup returns 410 and GET says setup is done', async () => {
    const res = await http()
      .post('/api/v1/setup')
      .send(body({ email: 'eve@example.com' }));
    expect(res.status).toBe(410);
    const get = await http().get('/api/v1/setup');
    expect(get.body).toEqual({ needsSetup: false });
    expect(await users()).toHaveLength(1);
  });

  it('ensureInstall after setup issues no code and keeps the install id', async () => {
    const before = (await row()).id;
    expect(await installs.ensureInstall()).toEqual({ installId: before, setupCode: null });
  });

  it('only the install owner can create workspaces through the server API', async () => {
    const owner = (await row()).ownerUserId!;
    const { user: other } = await t.auth.api.createUser({
      body: { email: 'other@example.com', password: PASSWORD, name: 'Other' },
    });
    await expect(
      t.auth.api.createOrganization({ body: { name: 'Nope', slug: 'nope', userId: other.id } }),
    ).rejects.toBeInstanceOf(APIError);
    const ok = await t.auth.api.createOrganization({
      body: { name: 'Second', slug: 'second', userId: owner },
    });
    expect(ok.id).toBeTruthy();
    expect(await orgs()).toHaveLength(2);
  });

  it('keeps the HTTP workspace route blocked', async () => {
    const res = await http().post('/api/auth/organization/create').send({ name: 'x', slug: 'x' });
    expect(res.status).toBe(403);
  });
});

describe('setup concurrency', () => {
  it('lets exactly one of two concurrent setups win', async () => {
    const t = await createTestApp();
    try {
      const code = (await t.app.get(InstallService).ensureInstall()).setupCode!;
      const post = (email: string) =>
        request(t.app.getHttpServer())
          .post('/api/v1/setup')
          .send({ code, name: 'Ada', email, password: PASSWORD });
      const [a, b] = await Promise.all([post('ada@example.com'), post('eve@example.com')]);
      expect([a.status, b.status].sort()).toEqual([201, 410]);
      expect(await t.db.db.select().from(authSchema.user)).toHaveLength(1);
      expect(await t.db.db.select().from(authSchema.organization)).toHaveLength(1);
    } finally {
      await t.close();
    }
  });
});

describe('setup rollback', () => {
  it('removes the user and leaves no owner when workspace creation fails', async () => {
    const t = await createTestApp();
    try {
      const code = (await t.app.get(InstallService).ensureInstall()).setupCode!;
      const send = () =>
        request(t.app.getHttpServer())
          .post('/api/v1/setup')
          .send({ code, name: 'Ada', email: 'ada@example.com', password: PASSWORD });
      const sql = (q: string) => t.db.db.$client.query(q);
      await sql(
        `CREATE FUNCTION fail_org() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'boom'; END $$ LANGUAGE plpgsql`,
      );
      await sql(
        `CREATE TRIGGER fail_org BEFORE INSERT ON "organization" FOR EACH ROW EXECUTE FUNCTION fail_org()`,
      );

      const res = await send();
      expect(res.status).toBe(500);
      expect(await t.db.db.select().from(authSchema.user)).toHaveLength(0);
      expect(await t.db.db.select().from(authSchema.account)).toHaveLength(0);
      const [inst] = await t.db.db.select().from(install);
      expect(inst!.ownerUserId).toBeNull();
      expect(inst!.setupCodeHash).not.toBeNull();

      await sql(`DROP TRIGGER fail_org ON "organization"`);
      expect((await send()).status).toBe(201);
    } finally {
      await t.close();
    }
  });
});
