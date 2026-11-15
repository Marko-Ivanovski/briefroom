import { afterEach, describe, expect, it } from 'vitest';
import { run } from '../src/cli.ts';
import { loadCredentials, saveWorkspaceToken } from '../src/credentials.ts';
import { json, SECRET, startStub, testContext, type Stub, type TestContext } from './helpers.ts';

describe('disconnect', () => {
  const stubs: Stub[] = [];
  let t: TestContext | undefined;

  afterEach(async () => {
    await Promise.all(stubs.splice(0).map((s) => s.close()));
    await t?.cleanup();
  });

  async function install(
    installId: string,
    handler: (url: string) => [number, unknown],
  ): Promise<Stub> {
    const stub = await startStub((req, res) => {
      const [status, body] = handler(req.url);
      if (status === 204) {
        res.writeHead(204);
        return void res.end();
      }
      json(res, status, body);
    });
    stubs.push(stub);
    await saveWorkspaceToken(t!.home, { installId, baseUrl: stub.baseUrl }, `ws-${installId}`, {
      name: `Name ${installId}`,
      token: `${SECRET}_${installId}`,
    });
    return stub;
  }

  const healthy = (url: string): [number, unknown] =>
    url === '/api/version' ? [200, { api: '1' }] : [204, null];

  it('deletes the token with its own Bearer and removes the local credential', async () => {
    t = await testContext();
    const stub = await install('a', healthy);
    expect(await run(['disconnect'], t.ctx)).toBe(0);
    const del = stub.requests.find((r) => r.method === 'DELETE')!;
    expect(del.url).toBe('/api/v1/tokens/self');
    expect(del.authorization).toBe(`Bearer ${SECRET}_a`);
    expect((await loadCredentials(t.home)).installs).toEqual({});
    expect([...t.stdout, ...t.stderr].join('')).not.toContain(SECRET);
  });

  it('removes the local credential even when the server fails, with a warning', async () => {
    t = await testContext();
    await install('a', (url) =>
      url === '/api/version' ? [200, { api: '1' }] : [500, { boom: 1 }],
    );
    expect(await run(['disconnect'], t.ctx)).toBe(0);
    expect((await loadCredentials(t.home)).installs).toEqual({});
    expect(t.stderr.join('')).toContain('Warning');
    expect(t.stderr.join('')).not.toContain(SECRET);
  });

  it('removes the local credential when the install cannot be reached', async () => {
    t = await testContext();
    const stub = await install('a', healthy);
    await stub.close();
    expect(await run(['disconnect'], t.ctx)).toBe(0);
    expect((await loadCredentials(t.home)).installs).toEqual({});
    expect(t.stderr.join('')).toContain('Could not reach');
  });

  it('exits 2 with the update message on an API mismatch, after removing the local credential', async () => {
    t = await testContext();
    const stub = await install('a', () => [200, { api: '3' }]);
    expect(await run(['disconnect'], t.ctx)).toBe(2);
    expect(t.stderr.join('')).toContain(
      'This Briefroom install runs API v3. Update the CLI with npm i -g briefroom.\n',
    );
    expect(stub.requests.some((r) => r.method === 'DELETE')).toBe(false);
    expect((await loadCredentials(t.home)).installs).toEqual({});
  });

  it('with --all, revokes every install', async () => {
    t = await testContext();
    const a = await install('a', healthy);
    const b = await install('b', healthy);
    expect(await run(['disconnect', '--all'], t.ctx)).toBe(0);
    for (const s of [a, b]) expect(s.requests.filter((r) => r.method === 'DELETE')).toHaveLength(1);
    expect((await loadCredentials(t.home)).installs).toEqual({});
  });

  it('without --all and outside a linked repo, refuses when several workspaces are saved', async () => {
    t = await testContext();
    await install('a', healthy);
    await install('b', healthy);
    expect(await run(['disconnect'], t.ctx)).toBe(1);
    expect(Object.keys((await loadCredentials(t.home)).installs)).toEqual(['a', 'b']);
  });

  it('says so when there is nothing to disconnect', async () => {
    t = await testContext();
    expect(await run(['disconnect'], t.ctx)).toBe(0);
    expect(t.stdout.join('')).toBe('Nothing to disconnect.\n');
  });
});
