import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveCommand } from '../src/resolve-command.ts';

describe('resolveCommand', () => {
  let dir: string;
  let previous: string;

  beforeEach(async () => {
    dir = await realpath(await mkdtemp(join(tmpdir(), 'briefroom-resolve-')));
    previous = process.cwd();
    process.chdir(dir);
  });

  afterEach(async () => {
    process.chdir(previous);
    await rm(dir, { recursive: true, force: true });
  });

  async function plant(folder: string, file: string): Promise<string> {
    await mkdir(folder, { recursive: true });
    const path = join(folder, file);
    await writeFile(path, '', { mode: 0o755 });
    return path;
  }

  it('never picks a file from the working directory through relative or empty PATH entries', async () => {
    await plant(dir, 'claude');
    await plant(dir, 'claude.exe');
    await plant(join(dir, 'bin'), 'claude');
    const env = { PATH: ['', '.', 'bin', './bin'].join(delimiter), PATHEXT: '.EXE;.CMD' };
    expect(resolveCommand('claude', env, process.platform)).toBeNull();
    expect(resolveCommand('claude', env, 'win32')).toBeNull();
  });

  it('resolves to the absolute path inside an absolute PATH entry', async () => {
    const bin = join(dir, 'abs-bin');
    const file = await plant(bin, process.platform === 'win32' ? 'claude.exe' : 'claude');
    const found = resolveCommand(
      'claude',
      { PATH: ['', 'rel', bin].join(delimiter), PATHEXT: '.EXE;.CMD' },
      process.platform,
    );
    expect(found).toBe(file);
    expect(isAbsolute(found!)).toBe(true);
  });

  it('tries PATHEXT extensions in order on Windows', async () => {
    const bin = join(dir, 'win-bin');
    const cmd = await plant(bin, 'claude.cmd');
    const exe = await plant(bin, 'claude.exe');
    expect(resolveCommand('claude', { PATH: bin, PATHEXT: '.EXE;.CMD' }, 'win32')).toBe(exe);
    expect(resolveCommand('claude', { PATH: bin, PATHEXT: '.CMD;.EXE' }, 'win32')).toBe(cmd);
  });
});
