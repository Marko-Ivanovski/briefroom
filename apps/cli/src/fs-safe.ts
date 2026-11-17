import { randomBytes } from 'node:crypto';
import { chmod, lstat, rename, rm, writeFile } from 'node:fs/promises';
import { CliError } from './errors.ts';

/** Refuses a path that is a symbolic link, so a write never lands on a file the link points at. */
export async function refuseSymlink(path: string): Promise<void> {
  const info = await lstat(path).catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT') return null;
    throw err;
  });
  if (info?.isSymbolicLink()) {
    throw new CliError(`${path} is a symbolic link. Refusing to write through it.`);
  }
}

/**
 * Writes a temp file in the same folder and renames it over the target. Rename replaces the path
 * itself, never what a link at that path points to. `wx` and a random name keep a pre-placed temp
 * file or link from being followed, and the mode is set before the content is visible under its name.
 */
export async function writeFileReplacing(path: string, data: string, mode: number): Promise<void> {
  await refuseSymlink(path);
  const temp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    await writeFile(temp, data, { mode, flag: 'wx' });
    // Best effort: Windows does not honour modes.
    await chmod(temp, mode).catch(() => undefined);
    await rename(temp, path);
  } catch (err) {
    await rm(temp, { force: true });
    throw err;
  }
}
