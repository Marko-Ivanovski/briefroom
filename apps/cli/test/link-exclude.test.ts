import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const repoRef = vi.hoisted(() => ({ root: '' }));

// Models real git: --path-format=absolute resolves a symlinked info/exclude to the file it points at,
// and the plain form keeps the path as it is in the repository.
vi.mock('node:child_process', () => ({
  execFile: (
    _file: string,
    args: string[],
    _options: unknown,
    done: (err: Error | null, out: { stdout: string; stderr: string }) => void,
  ) => {
    const reply = (stdout: string) => done(null, { stdout, stderr: '' });
    if (args.includes('--show-toplevel')) return reply(`${repoRef.root}\n`);
    if (args.includes('--path-format=absolute')) return reply(`${repoRef.root}/victim.txt\n`);
    return reply('.git/info/exclude\n');
  },
}));

// A Windows account cannot make a symlink, so the link is stubbed where lstat sees it.
vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...real,
    lstat: async (path: string, ...rest: unknown[]) =>
      String(path).replaceAll('\\', '/').endsWith('.git/info/exclude')
        ? { isSymbolicLink: () => true }
        : (real.lstat as (p: string, ...r: unknown[]) => Promise<unknown>)(path, ...rest),
  };
});

const { run } = await import('../src/cli.ts');
const { saveWorkspaceToken } = await import('../src/credentials.ts');
const { SECRET, testContext } = await import('./helpers.ts');

describe('link --private with a symlinked .git/info/exclude', () => {
  let cleanup: (() => Promise<void>) | undefined;
  let repo: string | undefined;

  afterEach(async () => {
    await cleanup?.();
    if (repo) await rm(repo, { recursive: true, force: true });
  });

  it('exits 1 with the symbolic link message and writes nothing', async () => {
    repo = await mkdtemp(join(tmpdir(), 'briefroom-cli-exclude-'));
    repoRef.root = repo.replace(/\\/g, '/');
    const t = await testContext({ cwd: repo });
    cleanup = t.cleanup;
    await saveWorkspaceToken(t.home, { installId: 'i1', baseUrl: 'http://briefroom.test' }, 'ws1', {
      name: 'Acme',
      token: SECRET,
    });

    expect(await run(['link', '--private'], t.ctx)).toBe(1);
    expect(t.stderr.join('')).toContain('symbolic link');
    await expect(stat(join(repo, '.briefroom.json'))).rejects.toThrow();
    await expect(readFile(join(t.home, '.briefroom', 'links.json'), 'utf8')).rejects.toThrow();
  });
});
