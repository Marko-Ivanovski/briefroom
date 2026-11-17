import { readFile, stat, mkdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { run } from '../src/cli.ts';
import { credentialsPath, loadCredentials, saveWorkspaceToken } from '../src/credentials.ts';
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
          approveUrl: 'http://localhost:4300/connect',
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
        [stub!.baseUrl]: { installId: 'i1', workspaces: { ws1: { name: 'Acme', token: SECRET } } },
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
    expect(t!.opened).toEqual(['http://localhost:4300/connect']);
    const printed = [...t!.stdout, ...t!.stderr].join('');
    expect(printed).toContain('http://localhost:4300/connect');
    expect(printed).not.toContain('connect?code');
    expect(printed).toContain('ABCD-EFGH');
    expect(printed).not.toContain(SECRET);
  });

  it('keys the entry by the address the user typed, not the one the server reports', async () => {
    await loginOnce();
    const saved = await loadCredentials(t!.home);
    expect(Object.keys(saved.installs)).toEqual([stub!.baseUrl]);
    expect(saved.installs[stub!.baseUrl]!.installId).toBe('i1');
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
    expect(Object.keys(saved.installs[stub!.baseUrl]!.workspaces)).toEqual(['ws1']);
  });

  it('refuses a credentials file it cannot read instead of overwriting it', async () => {
    t = await testContext();
    await mkdir(join(t.home, '.briefroom'));
    await writeFile(credentialsPath(t.home), 'not json');
    await expect(loadCredentials(t.home)).rejects.toThrow('is not valid');
  });

  it('refuses a login whose poll answer names a different install than /api/version', async () => {
    stub = await startStub((req, res) => {
      if (req.url === '/api/version') return json(res, 200, { api: '1', installId: 'real' });
      if (req.url === '/api/v1/cli-login') {
        return json(res, 201, {
          code: 'ABCD-EFGH',
          approveUrl: 'http://x/connect',
          pollToken: 'p',
        });
      }
      return json(res, 200, {
        status: 'approved',
        token: SECRET,
        workspaceId: 'ws1',
        workspaceName: 'Acme',
        installId: 'other',
      });
    });
    t = await testContext();
    expect(await run(['login', stub.baseUrl], t.ctx)).toBe(1);
    expect(t.stderr.join('')).toContain('different install');
    expect((await loadCredentials(t.home)).installs).toEqual({});
    expect(t.stderr.join('')).not.toContain(SECRET);
  });

  it('never rebases a saved entry onto an address that reports another install', async () => {
    await loginOnce();
    const saved = await loadCredentials(t!.home);
    await expect(
      saveWorkspaceToken(t!.home, { installId: 'attacker', baseUrl: stub!.baseUrl }, 'ws9', {
        name: 'Evil',
        token: 'brf_evil',
      }),
    ).rejects.toThrow('different install');
    expect(await loadCredentials(t!.home)).toEqual(saved);
  });

  it.skipIf(process.platform === 'win32')(
    'refuses to write through a symlinked credentials file',
    async () => {
      t = await testContext();
      const victim = join(t.home, 'victim.txt');
      await mkdir(join(t.home, '.briefroom'));
      await writeFile(victim, 'keep me');
      await symlink(victim, credentialsPath(t.home));
      await expect(
        saveWorkspaceToken(t.home, { installId: 'i', baseUrl: 'http://127.0.0.1:1' }, 'w', {
          name: 'n',
          token: 't',
        }),
      ).rejects.toThrow('symbolic link');
      expect(await readFile(victim, 'utf8')).toBe('keep me');
    },
  );
});
