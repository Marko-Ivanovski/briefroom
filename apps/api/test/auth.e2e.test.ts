import { Logger, UnauthorizedException } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createAuth } from '../src/auth/auth.ts';
import { userFromRequest } from '../src/auth/current-user.decorator.ts';
import { loadEnv } from '../src/config/env.ts';
import { createTestApp, type TestApp } from './helpers.ts';

const ORIGIN = 'http://localhost:4300';
const PASSWORD = 'correct horse battery';

describe('auth', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });

  afterAll(async () => {
    await t.close();
  });

  function http() {
    return request(t.app.getHttpServer());
  }

  async function createUser(email: string, role?: 'user' | 'admin'): Promise<string> {
    const { user } = await t.auth.api.createUser({
      body: { email, password: PASSWORD, name: email, role },
    });
    return user.id;
  }

  // Server-side sign-in: the HTTP sign-in route is rate limited by socket address, shared by all tests here.
  async function signIn(email: string): Promise<string> {
    const res = await t.auth.api.signInEmail({
      body: { email, password: PASSWORD },
      asResponse: true,
    });
    const cookies = res.headers.getSetCookie().map((c) => c.split(';')[0]);
    expect(cookies.join(';')).toContain('better-auth.session_token=');
    return cookies.join('; ');
  }

  it('rejects public sign-up over HTTP', async () => {
    const res = await http()
      .post('/api/auth/sign-up/email')
      .send({ email: 'x@example.com', password: PASSWORD, name: 'X' });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  it('lets a user created through the admin plugin sign in and get a session', async () => {
    await createUser('member@example.com');
    const signedIn = await http()
      .post('/api/auth/sign-in/email')
      .send({ email: 'member@example.com', password: PASSWORD });
    expect(signedIn.status).toBe(200);
    const cookie = await signIn('member@example.com');
    const res = await http().get('/api/auth/get-session').set('cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe('member@example.com');
  });

  it('keeps health public although the auth guard is global', async () => {
    const res = await http().get('/api/health');
    expect(res.status).toBe(200);
  });

  describe('blocked organization endpoints', () => {
    it('refuses remove-member with 403 for an admin session and leaves the member in place', async () => {
      const adminId = await createUser('ws-admin@example.com', 'admin');
      const memberId = await createUser('ws-member@example.com');
      const org = await t.auth.api.createOrganization({
        body: { name: 'Acme', slug: 'acme', userId: adminId },
      });
      await t.auth.api.addMember({
        body: { userId: memberId, role: 'member', organizationId: org.id },
      });
      const cookie = await signIn('ws-admin@example.com');

      const res = await http()
        .post('/api/auth/organization/remove-member')
        .set('cookie', cookie)
        .set('origin', ORIGIN)
        .send({ memberIdOrEmail: 'ws-member@example.com', organizationId: org.id });

      expect(res.status).toBe(403);
      const { members } = await t.auth.api.listMembers({
        query: { organizationId: org.id },
        headers: new Headers({ cookie }),
      });
      expect(members.map((m: { userId: string }) => m.userId)).toContain(memberId);
    });

    it.each(['create', 'invite-member', 'accept-invitation', 'update-member-role', 'leave'])(
      'refuses /organization/%s with 403',
      async (action) => {
        const email = `blocked-${action}@example.com`;
        await createUser(email);
        const cookie = await signIn(email);
        const res = await http()
          .post(`/api/auth/organization/${action}`)
          .set('cookie', cookie)
          .set('origin', ORIGIN)
          .send({
            name: 'Mine',
            slug: 'mine',
            email: 'a@b.co',
            role: 'member',
            invitationId: 'x',
            organizationId: 'x',
            memberId: 'x',
          });
        expect(res.status).toBe(403);
      },
    );

    it.each([
      ['POST', '/organization/update'],
      ['POST', '/organization/delete'],
      ['GET', '/admin/list-users'],
      ['POST', '/admin/create-user'],
      ['POST', '/api-key/create'],
    ])('denies %s /api/auth%s with 403 for a signed-in user', async (method, path) => {
      const email = `deny-${path.replace(/\W/g, '')}@example.com`;
      await createUser(email);
      const cookie = await signIn(email);
      const req =
        method === 'GET' ? http().get(`/api/auth${path}`) : http().post(`/api/auth${path}`);
      const res = await req.set('cookie', cookie).set('origin', ORIGIN).send({});
      expect(res.status).toBe(403);
    });

    it('still allows server-side organization calls', async () => {
      const userId = await createUser('server-side@example.com');
      const org = await t.auth.api.createOrganization({
        body: { name: 'Server', slug: 'server-side', userId },
      });
      expect(org.id).toBeTruthy();
    });
  });

  it('issues API keys with the brf_ prefix', async () => {
    const userId = await createUser('keys@example.com');
    const created = await t.auth.api.createApiKey({ body: { name: 'cli', userId } });
    expect(created.key.startsWith('brf_')).toBe(true);
  });

  describe('createAuth config', () => {
    const base = { DATABASE_URL: 'postgres://x/y' };

    it('uses secure cookies when the public url is https', () => {
      const env = loadEnv({ ...base, BRIEFROOM_PUBLIC_URL: 'https://briefroom.example' });
      const auth = createAuth(t.db.db, env);
      expect(auth.options.advanced?.useSecureCookies).toBe(true);
      expect(auth.options.baseURL).toBe('https://briefroom.example');
      expect(auth.options.trustedOrigins).toEqual(['https://briefroom.example']);
    });

    it('does not force secure cookies for an http public url', () => {
      const env = loadEnv({ ...base, BRIEFROOM_PUBLIC_URL: 'http://localhost:4300' });
      expect(createAuth(t.db.db, env).options.advanced?.useSecureCookies).toBe(false);
    });
  });

  describe('dev secret warning', () => {
    function devWarnings(spy: { mock: { calls: unknown[][] } }): string[] {
      return spy.mock.calls.map((c) => String(c[0])).filter((m) => /dev-only/i.test(m));
    }

    it('logs one warning at startup when the dev secret is in use', async () => {
      const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
      try {
        const other = await createTestApp();
        await other.close();
        expect(devWarnings(warn)).toHaveLength(1);
      } finally {
        warn.mockRestore();
      }
    });

    it('does not warn with a real secret', async () => {
      const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
      try {
        const other = await createTestApp({ BETTER_AUTH_SECRET: 'y'.repeat(40) });
        await other.close();
        expect(devWarnings(warn)).toHaveLength(0);
      } finally {
        warn.mockRestore();
      }
    });
  });
});

describe('userFromRequest', () => {
  it('returns id, name and email from the session', () => {
    const sessionUser = { id: 'u1', name: 'Ann', email: 'a@b.co', role: 'admin' };
    const user = userFromRequest({ session: { user: sessionUser } });
    expect(user).toEqual({ id: 'u1', name: 'Ann', email: 'a@b.co' });
  });

  it('throws 401 without a session', () => {
    expect(() => userFromRequest({})).toThrow(UnauthorizedException);
    expect(() => userFromRequest({ session: null })).toThrow(UnauthorizedException);
  });
});

describe('sign-in rate limit', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });

  afterAll(async () => {
    await t.close();
  });

  async function attempts(headersFor: (i: number) => Record<string, string>): Promise<number[]> {
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      const res = await request(t.app.getHttpServer())
        .post('/api/auth/sign-in/email')
        .set(headersFor(i))
        .send({ email: 'nobody@example.com', password: 'wrong-password' });
      statuses.push(res.status);
    }
    return statuses;
  }

  it('limits by socket address even when X-Forwarded-For changes on every attempt', async () => {
    const statuses = await attempts((i) => ({ 'x-forwarded-for': `10.8.0.${i + 1}` }));
    expect(statuses[5]).toBe(429);
    expect(statuses.slice(0, 4)).not.toContain(429);
  });
});

describe('client ip header', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });

  afterAll(async () => {
    await t.close();
  });

  it('ignores a client-sent x-briefroom-client-ip value', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      const res = await request(t.app.getHttpServer())
        .post('/api/auth/sign-in/email')
        .set('x-briefroom-client-ip', `10.7.0.${i + 1}`)
        .send({ email: 'nobody@example.com', password: 'wrong-password' });
      statuses.push(res.status);
    }
    expect(statuses[5]).toBe(429);
  });
});
