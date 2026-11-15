import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string | null> {
  try {
    return (await run('git', args, { cwd })).stdout.trim();
  } catch {
    return null;
  }
}

/** The repository's top folder, or null outside a git repository. */
export function repoRoot(cwd: string): Promise<string | null> {
  return git(cwd, ['rev-parse', '--show-toplevel']);
}

/** Where git keeps the repo-local ignore list. Right inside worktrees too, where .git is a file. */
export function excludeFile(cwd: string): Promise<string | null> {
  return git(cwd, ['rev-parse', '--path-format=absolute', '--git-path', 'info/exclude']);
}
