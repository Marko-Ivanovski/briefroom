import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { run } from '../src/cli.ts';
import { json, startStub, testContext, type Stub, type TestContext } from './helpers.ts';

const root = join(import.meta.dirname, '..', '..', '..');
const SOURCE = 'https://github.com/Marko-Ivanovski/briefroom.git';

describe('login plugin offer', () => {
  let stub: Stub | undefined;
  let t: TestContext | undefined;
  let calls: [string, string[]][];

  afterEach(async () => {
    await stub?.close();
    await t?.cleanup();
  });

  async function setup(overrides: Parameters<typeof testContext>[0] = {}): Promise<TestContext> {
    calls = [];
    stub = await startStub((req, res) => {
      if (req.url === '/api/version') return json(res, 200, { api: '1', installId: 'inst-1' });
      if (req.url === '/api/v1/cli-login') {
        return json(res, 201, { code: 'AAAA-BBBB', approveUrl: 'http://x/c', pollToken: 'p' });
      }
      return json(res, 200, {
        status: 'approved',
        token: 'brf_x',
        workspaceId: 'ws1',
        workspaceName: 'Acme',
        installId: 'inst-1',
      });
    });
    t = await testContext({
      exec: (file, args) => {
        calls.push([file, args]);
        return Promise.resolve();
      },
      ...overrides,
    });
    return t;
  }

  const commands: [string, string[]][] = [
    ['claude', ['plugin', 'marketplace', 'add', SOURCE]],
    ['claude', ['plugin', 'install', 'briefroom@briefroom']],
  ];
  const printed = [
    `claude plugin marketplace add ${SOURCE}`,
    'claude plugin install briefroom@briefroom',
  ];

  it('runs exactly the two claude commands, without a shell, after y', async () => {
    await setup({
      interactive: true,
      hasCommand: (name) => Promise.resolve(name === 'claude'),
      confirm: (prompt) => {
        expect(prompt).toBe('Install the Briefroom plugin for Claude Code? [y/N]');
        return Promise.resolve(true);
      },
    });
    expect(await run(['login', stub!.baseUrl], t!.ctx)).toBe(0);
    expect(calls).toEqual(commands);
  });

  it('runs nothing and prints the commands after N', async () => {
    await setup({
      interactive: true,
      hasCommand: () => Promise.resolve(true),
      confirm: () => Promise.resolve(false),
    });
    expect(await run(['login', stub!.baseUrl], t!.ctx)).toBe(0);
    expect(calls).toEqual([]);
    for (const line of printed) expect(t!.stdout.join('')).toContain(line);
  });

  it('runs nothing and prints the commands without a terminal', async () => {
    await setup({ interactive: false, hasCommand: () => Promise.resolve(true) });
    expect(await run(['login', stub!.baseUrl], t!.ctx)).toBe(0);
    expect(calls).toEqual([]);
    for (const line of printed) expect(t!.stdout.join('')).toContain(line);
  });

  it('prints the commands when claude is not on PATH', async () => {
    await setup({ interactive: true, hasCommand: () => Promise.resolve(false) });
    expect(await run(['login', stub!.baseUrl], t!.ctx)).toBe(0);
    expect(calls).toEqual([]);
    for (const line of printed) expect(t!.stdout.join('')).toContain(line);
  });

  it('still exits 0 and warns when claude fails', async () => {
    await setup({
      interactive: true,
      hasCommand: () => Promise.resolve(true),
      confirm: () => Promise.resolve(true),
      exec: () => Promise.reject(new Error('boom')),
    });
    expect(await run(['login', stub!.baseUrl], t!.ctx)).toBe(0);
    expect(t!.stderr.join('')).toContain('Warning');
    for (const line of printed) expect(t!.stdout.join('')).toContain(line);
  });

  it('uses the marketplace and plugin names that the plugin files declare', async () => {
    const market = JSON.parse(
      await readFile(join(root, '.claude-plugin', 'marketplace.json'), 'utf8'),
    ) as { name: string; plugins: { name: string }[] };
    const plugin = JSON.parse(
      await readFile(join(root, 'plugins', 'claude-code', '.claude-plugin', 'plugin.json'), 'utf8'),
    ) as { name: string };
    expect(commands[1]![1][2]).toBe(`${plugin.name}@${market.name}`);
    expect(market.plugins[0]!.name).toBe(plugin.name);
  });
});
