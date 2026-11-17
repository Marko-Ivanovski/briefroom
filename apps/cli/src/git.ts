import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { CliError } from './errors.ts';
import { resolveCommand } from './resolve-command.ts';

const run = promisify(execFile);

function resolveGit(): string {
  const git = resolveCommand('git', process.env, process.platform);
  if (!git) throw new CliError('git was not found on PATH. Install git to use this command.');
  if (/\.(cmd|bat)$/i.test(git)) {
    throw new CliError(
      'git is installed as a batch shim, which is never run. Put git.exe on PATH.',
    );
  }
  return git;
}

async function git(cwd: string, args: string[]): Promise<string | null> {
  const file = resolveGit();
  try {
    return (await run(file, args, { cwd })).stdout.trim();
  } catch {
    return null;
  }
}

/** The repository's top folder, or null outside a git repository. */
export function repoRoot(cwd: string): Promise<string | null> {
  return git(cwd, ['rev-parse', '--show-toplevel']);
}

/** Where git keeps the repo-local ignore list. Right inside worktrees too, where .git is a file. */
export async function excludeFile(cwd: string): Promise<string | null> {
  // Not --path-format=absolute: it resolves a symlinked exclude to its target, which would hide the link from the symlink check.
  const path = await git(cwd, ['rev-parse', '--git-path', 'info/exclude']);
  return path ? resolve(cwd, path) : null;
}
