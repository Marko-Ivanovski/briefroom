import { inspect } from 'node:util';
import { Controller, Inject, Logger, Post, type LoggerService } from '@nestjs/common';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AUTH } from '../src/auth/auth.module.ts';
import type { Auth } from '../src/auth/auth.ts';
import { CurrentUser, type CurrentUserData } from '../src/auth/current-user.decorator.ts';
import { InstallService } from '../src/install/install.service.ts';
import { createTestApp, makeInstallOwner, type TestApp } from './helpers.ts';

const PASSWORD = 'correct horse battery';
const EMAIL = 'ada@example.com';

@Controller('v1/probe')
class OrgProbeController {
  constructor(@Inject(AUTH) private readonly auth: Auth) {}

  @Post('org')
  create(@CurrentUser() user: CurrentUserData) {
    return this.auth.api.createOrganization({
      body: { name: 'Sneaky', slug: 'sneaky', userId: user.id },
    });
  }
}

const render = (args: unknown[]): string =>
  args.map((a) => (typeof a === 'string' ? a : inspect(a, { depth: 8 }))).join(' ');

class Capture implements LoggerService {
  readonly lines: string[] = [];
  private push = (...args: unknown[]) => {
    this.lines.push(render(args));
  };
  log = this.push;
  error = this.push;
  warn = this.push;
  debug = this.push;
  verbose = this.push;
  fatal = this.push;
  get text(): string {
    return this.lines.join('\n');
  }
}

function expectNoSecrets(text: string): void {
  expect(text).not.toContain('params:');
  expect(text).not.toContain('Failed query');
  expect(text).not.toContain(EMAIL);
  expect(text).not.toContain(PASSWORD);
  expect(text).not.toMatch(/[0-9a-f]{64,}/);
}

describe('logs never carry query parameters or secrets', () => {
  let t: TestApp;
  let capture: Capture;
  const consoleSpies: { mockRestore(): void }[] = [];

  const http = () => request(t.app.getHttpServer());
  const rename = (from: string, to: string) =>
    t.db.db.$client.query(`ALTER TABLE ${from} RENAME TO ${to}`);
  const cookieFor = async (email: string): Promise<string> => {
    const res = await t.auth.api.signInEmail({
      body: { email, password: PASSWORD },
      asResponse: true,
    });
    return res.headers
      .getSetCookie()
      .map((c) => c.split(';')[0])
      .join('; ');
  };

  beforeAll(async () => {
    t = await createTestApp({}, [OrgProbeController]);
  });

  afterAll(async () => {
    await t.close();
  });

  beforeEach(() => {
    capture = new Capture();
    Logger.overrideLogger(capture);
    for (const method of ['error', 'warn', 'log'] as const) {
      consoleSpies.push(
        vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
          capture.lines.push(render(args));
        }),
      );
    }
  });

  afterEach(() => {
    for (const spy of consoleSpies.splice(0)) spy.mockRestore();
    Logger.overrideLogger(false);
  });

  it('a database failure during first-run setup', async () => {
    const { setupCode } = await t.app.get(InstallService).ensureInstall();
    await rename('account', 'account_x');
    try {
      const res = await http()
        .post('/api/v1/setup')
        .send({ code: setupCode, name: 'Ada', email: EMAIL, password: PASSWORD });
      expect(res.status).toBe(500);
      expect(JSON.stringify(res.body)).not.toContain(EMAIL);
    } finally {
      await rename('account_x', 'account');
    }
    expect(capture.text).not.toBe('');
    expectNoSecrets(capture.text);
  });

  it('a failing session lookup in Better Auth', async () => {
    await t.auth.api.createUser({
      body: { email: 'session@example.com', password: PASSWORD, name: 'Session' },
    });
    const cookie = await cookieFor('session@example.com');
    capture.lines.length = 0;
    await rename('session', 'session_x');
    try {
      const res = await http().get('/api/v1/me').set({ cookie });
      expect(res.status).toBe(500);
    } finally {
      await rename('session_x', 'session');
    }
    expectNoSecrets(capture.text);
  });

  it('an unknown error thrown from a handler logs its name only', async () => {
    const owner = await t.auth.api.createUser({
      body: { email: 'owner@example.com', password: PASSWORD, name: 'Owner' },
    });
    await makeInstallOwner(t, owner.user.id);
    const cookie = await cookieFor('owner@example.com');
    capture.lines.length = 0;
    await rename('member', 'member_x');
    try {
      const res = await http().get('/api/v1/workspaces').set({ cookie });
      expect(res.status).toBe(500);
      expect(res.body).toEqual({ statusCode: 500, message: 'Internal server error' });
    } finally {
      await rename('member_x', 'member');
    }
    expect(capture.text).toContain('DrizzleQueryError');
    expectNoSecrets(capture.text);
    expect(capture.text).not.toContain('owner@example.com');
  });

  it('a Better Auth APIError from a server call keeps its 4xx status', async () => {
    await t.auth.api.createUser({
      body: { email: 'plain@example.com', password: PASSWORD, name: 'Plain' },
    });
    const cookie = await cookieFor('plain@example.com');
    const res = await http().post('/api/v1/probe/org').set({ cookie });
    expect(res.status).toBe(403);
    expect(res.body).toEqual({
      statusCode: 403,
      message: 'Only the install owner can create workspaces',
    });
  });
});
