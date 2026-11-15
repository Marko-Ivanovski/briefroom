import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { run } from '../src/cli.ts';
import { saveWorkspaceToken } from '../src/credentials.ts';
import { SECRET, testContext, type TestContext } from './helpers.ts';

describe('link', () => {
  let t: TestContext | undefined;
  let repo: string | undefined;

  afterEach(async () => {
    await t?.cleanup();
    if (repo) await rm(repo, { recursive: true, force: true });
    t = undefined;
    repo = undefined;
  });

  async function setup(withRepo = true): Promise<TestContext> {
    repo = await mkdtemp(join(tmpdir(), 'briefroom-cli-repo-'));
    if (withRepo) execFileSync('git', ['init', '-q'], { cwd: repo });
    t = await testContext({ cwd: repo });
    await saveWorkspaceToken(t.home, { installId: 'i1', baseUrl: 'http://briefroom.test' }, 'ws1', {
      name: 'Acme',
      token: SECRET,
    });
    return t;
  }

  it('exits with code 1 outside a git repository', async () => {
    const { ctx, stderr } = await setup(false);
    expect(await run(['link'], ctx)).toBe(1);
    expect(stderr.join('')).toBe('Run briefroom link inside a git repository.\n');
  });

  it('writes .briefroom.json with ids only and prints no token', async () => {
    const { ctx, stdout, stderr } = await setup();
    expect(await run(['link'], ctx)).toBe(0);
    const raw = await readFile(join(repo!, '.briefroom.json'), 'utf8');
    expect(JSON.parse(raw)).toEqual({ installId: 'i1', workspaceId: 'ws1' });
    expect(raw).not.toContain(SECRET);
    expect([...stdout, ...stderr].join('')).not.toContain(SECRET);
  });

  it('writes the file at the repository root when run from a subfolder', async () => {
    await setup();
    await mkdir(join(repo!, 'src'));
    t!.ctx.cwd = join(repo!, 'src');
    expect(await run(['link'], t!.ctx)).toBe(0);
    expect(JSON.parse(await readFile(join(repo!, '.briefroom.json'), 'utf8')).workspaceId).toBe(
      'ws1',
    );
  });

  it('adds the file to .git/info/exclude once with --private', async () => {
    const { ctx } = await setup();
    await run(['link', '--private'], ctx);
    await run(['link', '--private'], ctx);
    const exclude = await readFile(join(repo!, '.git', 'info', 'exclude'), 'utf8');
    expect(exclude.split('\n').filter((l) => l === '.briefroom.json')).toHaveLength(1);
    expect(execFileSync('git', ['status', '--porcelain'], { cwd: repo }).toString()).toBe('');
  });

  it('leaves git exclude alone without --private', async () => {
    const { ctx } = await setup();
    await run(['link'], ctx);
    expect(await readFile(join(repo!, '.git', 'info', 'exclude'), 'utf8')).not.toContain(
      '.briefroom',
    );
  });

  it('asks which workspace to use when several are saved, and takes --workspace', async () => {
    const { ctx } = await setup();
    await saveWorkspaceToken(
      ctx.home,
      { installId: 'i1', baseUrl: 'http://briefroom.test' },
      'ws2',
      {
        name: 'Globex',
        token: 'brf_other',
      },
    );
    ctx.choose = (_prompt, options) => {
      expect(options).toHaveLength(2);
      return Promise.resolve(1);
    };
    expect(await run(['link'], ctx)).toBe(0);
    expect(JSON.parse(await readFile(join(repo!, '.briefroom.json'), 'utf8')).workspaceId).toBe(
      'ws2',
    );
    expect(await run(['link', '--workspace', 'acme'], ctx)).toBe(0);
    expect(JSON.parse(await readFile(join(repo!, '.briefroom.json'), 'utf8')).workspaceId).toBe(
      'ws1',
    );
  });

  it('tells you to log in when nothing is saved', async () => {
    repo = await mkdtemp(join(tmpdir(), 'briefroom-cli-repo-'));
    execFileSync('git', ['init', '-q'], { cwd: repo });
    t = await testContext({ cwd: repo });
    expect(await run(['link'], t.ctx)).toBe(1);
    expect(t.stderr.join('')).toContain('briefroom login');
  });

  // Creating symlinks on Windows needs a privilege most accounts lack, so these run on Unix only.
  it.skipIf(process.platform === 'win32')(
    'refuses when .briefroom.json is a symlink, and leaves its target alone',
    async () => {
      const { ctx, stderr } = await setup();
      const victim = join(repo!, '..', `victim-${Date.now()}.txt`);
      await writeFile(victim, 'keep me');
      await symlink(victim, join(repo!, '.briefroom.json'));
      try {
        expect(await run(['link'], ctx)).toBe(1);
        expect(stderr.join('')).toContain('symbolic link');
        expect(await readFile(victim, 'utf8')).toBe('keep me');
      } finally {
        await rm(victim, { force: true });
      }
    },
  );

  it.skipIf(process.platform === 'win32')(
    'refuses to append to a symlinked .git/info/exclude',
    async () => {
      const { ctx, stderr } = await setup();
      const victim = join(repo!, '..', `victim-ex-${Date.now()}.txt`);
      await writeFile(victim, 'keep me');
      await mkdir(join(repo!, '.git', 'info'), { recursive: true });
      await rm(join(repo!, '.git', 'info', 'exclude'), { force: true });
      await symlink(victim, join(repo!, '.git', 'info', 'exclude'));
      try {
        expect(await run(['link', '--private'], ctx)).toBe(1);
        expect(stderr.join('')).toContain('symbolic link');
        expect(await readFile(victim, 'utf8')).toBe('keep me');
      } finally {
        await rm(victim, { force: true });
      }
    },
  );
});
