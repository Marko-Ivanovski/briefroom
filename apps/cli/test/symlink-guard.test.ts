import { beforeEach, describe, expect, it, vi } from 'vitest';

// Runs everywhere: lstat is stubbed to report a symlink, so no symlink privilege is needed.
const lstat = vi.hoisted(() => vi.fn());
const readFile = vi.hoisted(() => vi.fn());

vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs/promises')>()),
  lstat,
  readFile,
}));

import { readLink } from '../src/commands/link.ts';
import { loadCredentials, saveWorkspaceToken } from '../src/credentials.ts';
import { refuseSymlink } from '../src/fs-safe.ts';

describe('symlink guard', () => {
  beforeEach(() => {
    lstat.mockReset();
    readFile.mockReset();
    lstat.mockResolvedValue({ isSymbolicLink: () => true });
    readFile.mockResolvedValue('{"installs":{}}');
  });

  it('refuseSymlink rejects a symlink', async () => {
    await expect(refuseSymlink('/x/credentials.json')).rejects.toThrow('symbolic link');
  });

  it('loadCredentials refuses a symlink before reading it', async () => {
    await expect(loadCredentials('/home/u')).rejects.toThrow('symbolic link');
    expect(readFile).not.toHaveBeenCalled();
  });

  it('saveWorkspaceToken refuses a symlink before reading or writing', async () => {
    await expect(
      saveWorkspaceToken('/home/u', { installId: 'i', baseUrl: 'https://x.example' }, 'w', {
        name: 'n',
        token: 't',
      }),
    ).rejects.toThrow('symbolic link');
    expect(readFile).not.toHaveBeenCalled();
  });

  it('readLink treats a symlinked .briefroom.json as not linked, without reading it', async () => {
    expect(await readLink(process.cwd())).toBeNull();
    expect(readFile).not.toHaveBeenCalled();
  });

  it('a missing file is still an empty credentials set', async () => {
    lstat.mockRejectedValue(Object.assign(new Error('nope'), { code: 'ENOENT' }));
    readFile.mockRejectedValue(Object.assign(new Error('nope'), { code: 'ENOENT' }));
    expect(await loadCredentials('/home/u')).toEqual({ installs: {} });
  });
});
