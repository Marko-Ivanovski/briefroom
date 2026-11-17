import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { run } from '../src/cli.ts';
import { saveWorkspaceToken } from '../src/credentials.ts';
import { repoRoot } from '../src/git.ts';
import { SECRET, testContext, type TestContext } from './helpers.ts';

describe('git resolution', () => {
  let dir: string;
  let previousCwd: string;
  let previousPath: string | undefined;
  let previousPathExt: string | undefined;
  let t: TestContext | undefined;

  beforeEach(async () => {
    dir = await realpath(await mkdtemp(join(tmpdir(), 'briefroom-git-')));
    previousCwd = process.cwd();
    previousPath = process.env.PATH;
    previousPathExt = process.env.PATHEXT;
    process.chdir(dir);
  });

  afterEach(async () => {
    process.chdir(previousCwd);
    process.env.PATH = previousPath;
    if (previousPathExt === undefined) delete process.env.PATHEXT;
    else process.env.PATHEXT = previousPathExt;
    await t?.cleanup();
    t = undefined;
    await rm(dir, { recursive: true, force: true });
  });

  it('link never runs a git planted in the working directory', async () => {
    for (const name of ['git', 'git.exe', 'git.com', 'git.cmd']) {
      await writeFile(join(dir, name), '', { mode: 0o755 });
    }
    process.env.PATH = ['', '.', 'bin'].join(delimiter);
    t = await testContext({ cwd: dir });
    await saveWorkspaceToken(t.home, { installId: 'i1', baseUrl: 'http://briefroom.test' }, 'ws1', {
      name: 'Acme',
      token: SECRET,
    });
    expect(await run(['link'], t.ctx)).toBe(1);
    expect(t.stderr.join('')).toBe('git was not found on PATH. Install git to use this command.\n');
  });

  it.runIf(process.platform === 'win32')(
    'refuses a git that resolves to a batch shim',
    async () => {
      const bin = join(dir, 'abs-bin');
      await mkdir(bin);
      await writeFile(join(bin, 'git.cmd'), '');
      process.env.PATH = bin;
      process.env.PATHEXT = '.CMD';
      await expect(repoRoot(dir)).rejects.toThrow(/batch/);
    },
  );
});
