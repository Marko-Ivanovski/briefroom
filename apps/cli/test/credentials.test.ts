import { readFile, stat, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { run } from '../src/cli.ts';
import { credentialsPath, loadCredentials } from '../src/credentials.ts';
import { json, SECRET, startStub, testContext, type Stub, type TestContext } from './helpers.ts';

describe('credentials', () => {
  let stub: Stub | undefined;
  let t: TestContext | undefined;

  afterEach(async () => {
    await stub?.close();
    await t?.cleanup();
    stub = undefined;
    t = undefined;
  });

  async function loginOnce(): Promise<number> {
    let polls = 0;
    stub = await startStub((req, res) => {
      if (req.url === '/api/version')
        return json(res, 200, { api: '1', app: '0', installId: 'i1' });
      if (req.url === '/api/v1/cli-login') {
        return json(res, 201, {
          code: 'ABCD-EFGH',
          approveUrl: 'http://localhost:4300/connect?code=ABCD-EFGH',
          pollToken: 'poll',
          expiresAt: new Date(Date.now() + 600_000).toISOString(),
          interval: 2,
        });
      }
      polls++;
      if (polls < 2) return json(res, 200, { status: 'pending' });
      return json(res, 200, {
        status: 'approved',
        token: SECRET,
        workspaceId: 'ws1',
        workspaceName: 'Acme',
        installId: 'i1',
        baseUrl: 'http://elsewhere.example',
      });
    });
    t = await testContext();
    return run(['login', stub.baseUrl], t.ctx);
  }

  it('saves the token under the install and workspace, with owner-only modes', async () => {
    expect(await loginOnce()).toBe(0);
    const file = credentialsPath(t!.home);
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({
      installs: {
        i1: { baseUrl: stub!.baseUrl, workspaces: { ws1: { name: 'Acme', token: SECRET } } },
      },
    });
    expect(file.startsWith(t!.home)).toBe(true);
    // On Windows chmod is best effort and modes are not reported, so the profile folder's ACL is relied on.
    if (process.platform !== 'win32') {
      expect((await stat(file)).mode & 0o777).toBe(0o600);
      expect((await stat(join(t!.home, '.briefroom'))).mode & 0o777).toBe(0o700);
    }
  });

  it('opens the approval url, prints it with the code, and never prints the token', async () => {
    await loginOnce();
    expect(t!.opened).toEqual(['http://localhost:4300/connect?code=ABCD-EFGH']);
    const printed = [...t!.stdout, ...t!.stderr].join('');
    expect(printed).toContain('http://localhost:4300/connect?code=ABCD-EFGH');
    expect(printed).toContain('ABCD-EFGH');
    expect(printed).not.toContain(SECRET);
  });

  it('keeps the address the user typed rather than the one the server reports', async () => {
    await loginOnce();
    const saved = await loadCredentials(t!.home);
    expect(saved.installs.i1!.baseUrl).toBe(stub!.baseUrl);
  });

  it('does not open a browser with --no-browser', async () => {
    stub = await startStub((req, res) => {
      if (req.url === '/api/version') return json(res, 200, { api: '1' });
      if (req.url === '/api/v1/cli-login') {
        return json(res, 201, {
          code: 'ABCD-EFGH',
          approveUrl: 'http://x/connect',
          pollToken: 'p',
        });
      }
      return json(res, 200, { status: 'expired' });
    });
    t = await testContext();
    expect(await run(['login', stub.baseUrl, '--no-browser'], t.ctx)).toBe(1);
    expect(t.opened).toEqual([]);
    expect(t.stderr.join('')).toContain('The login expired or was not approved');
  });

  it('replaces the token when the same workspace logs in again', async () => {
    await loginOnce();
    expect(await run(['login', stub!.baseUrl], t!.ctx)).toBe(0);
    const saved = await loadCredentials(t!.home);
    expect(Object.keys(saved.installs.i1!.workspaces)).toEqual(['ws1']);
  });

  it('refuses a credentials file it cannot read instead of overwriting it', async () => {
    t = await testContext();
    await mkdir(join(t.home, '.briefroom'));
    await writeFile(credentialsPath(t.home), 'not json');
    await expect(loadCredentials(t.home)).rejects.toThrow('is not valid');
  });
});
