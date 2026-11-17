import { afterEach, describe, expect, it } from 'vitest';
import { run } from '../src/cli.ts';
import { credentialsPath } from '../src/credentials.ts';
import { json, startStub, testContext, type Stub, type TestContext } from './helpers.ts';
import { access } from 'node:fs/promises';

describe('login', () => {
  let stub: Stub | undefined;
  let t: TestContext | undefined;

  afterEach(async () => {
    await stub?.close();
    await t?.cleanup();
  });

  it('exits with code 2 and the update message when the install runs another API major', async () => {
    stub = await startStub((_req, res) => json(res, 200, { api: '2' }));
    t = await testContext();
    const code = await run(['login', stub.baseUrl], t.ctx);
    expect(code).toBe(2);
    expect(t.stderr.join('')).toBe(
      'This Briefroom install runs API v2. Update the CLI with npm i -g briefroom.\n',
    );
    expect(stub.requests.map((r) => r.url)).toEqual(['/api/version']);
    await expect(access(credentialsPath(t.home))).rejects.toThrow();
  });

  it('says so when the address is not a Briefroom install', async () => {
    stub = await startStub((_req, res) => json(res, 404, { nope: true }));
    t = await testContext();
    expect(await run(['login', stub.baseUrl], t.ctx)).toBe(1);
    expect(t.stderr.join('')).toContain('does not look like a Briefroom install');
  });

  it('waits the interval the server asks for between polls', async () => {
    const sleeps: number[] = [];
    let polls = 0;
    stub = await startStub((req, res) => {
      if (req.url === '/api/version') return json(res, 200, { api: '1' });
      if (req.url === '/api/v1/cli-login') {
        return json(res, 201, {
          code: 'ABCD-EFGH',
          approveUrl: 'http://x/connect',
          pollToken: 'p',
          interval: 5,
          expiresAt: new Date(Date.now() + 600_000).toISOString(),
        });
      }
      polls++;
      if (polls === 1) return json(res, 429, { code: 'rate_limited' });
      return json(res, 200, { status: 'expired' });
    });
    t = await testContext({
      sleep: (ms) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
    });
    await run(['login', stub.baseUrl], t.ctx);
    expect(sleeps).toEqual([5000, 10_000]);
  });

  it('gives up once the login has expired', async () => {
    stub = await startStub((req, res) => {
      if (req.url === '/api/version') return json(res, 200, { api: '1' });
      if (req.url === '/api/v1/cli-login') {
        return json(res, 201, {
          code: 'ABCD-EFGH',
          approveUrl: 'http://x/connect',
          pollToken: 'p',
          expiresAt: new Date(Date.now() - 1000).toISOString(),
        });
      }
      return json(res, 200, { status: 'pending' });
    });
    t = await testContext();
    expect(await run(['login', stub.baseUrl], t.ctx)).toBe(1);
    expect(stub.requests.some((r) => r.url === '/api/v1/cli-login/poll')).toBe(false);
  });
});
