import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { run } from '../src/cli.ts';
import { testContext, type TestContext } from './helpers.ts';

const DOCKER = resolve('/usr/bin/docker');

describe('reset-password', () => {
  let t: TestContext | undefined;
  afterEach(() => t?.cleanup());

  async function setup(overrides: Parameters<typeof testContext>[0] = {}, withCompose = true) {
    const calls: { file: string; args: string[]; cwd: string }[] = [];
    t = await testContext({
      resolveCommand: (name) => (name === 'docker' ? DOCKER : null),
      runInherited: (file, args, cwd) => {
        calls.push({ file, args, cwd });
        return Promise.resolve(0);
      },
      ...overrides,
    });
    const dir = join(t.home, 'install');
    await mkdir(dir);
    if (withCompose) await writeFile(join(dir, 'compose.yml'), 'name: briefroom\n');
    return { calls, dir };
  }

  it('runs the admin cli through docker compose in the install folder', async () => {
    const { calls, dir } = await setup();
    expect(await run(['reset-password', 'ana@example.com', '--dir', dir], t!.ctx)).toBe(0);
    expect(calls).toEqual([
      {
        file: DOCKER,
        args: [
          'compose',
          'exec',
          '-T',
          'app',
          'node',
          'apps/api/dist/admin-cli.js',
          'reset-password',
          'ana@example.com',
        ],
        cwd: dir,
      },
    ]);
  });

  it('passes the email as one argument, never through a shell', async () => {
    const { calls, dir } = await setup();
    const email = 'a b; rm -rf x@example.com';
    await run(['reset-password', email, '--dir', dir], t!.ctx);
    expect(calls[0]!.args.at(-1)).toBe(email);
  });

  it('returns the exit code of the admin cli', async () => {
    const { dir } = await setup({ runInherited: () => Promise.resolve(1) });
    expect(await run(['reset-password', 'x@example.com', '--dir', dir], t!.ctx)).toBe(1);
  });

  it('explains when docker is not on PATH', async () => {
    const { calls, dir } = await setup({ resolveCommand: () => null });
    expect(await run(['reset-password', 'x@example.com', '--dir', dir], t!.ctx)).toBe(1);
    expect(t!.stderr.join('')).toContain('Docker');
    expect(calls).toEqual([]);
  });

  it('explains when the folder holds no install', async () => {
    const { calls, dir } = await setup({}, false);
    expect(await run(['reset-password', 'x@example.com', '--dir', dir], t!.ctx)).toBe(1);
    expect(t!.stderr.join('')).toContain('compose.yml');
    expect(calls).toEqual([]);
  });
});
