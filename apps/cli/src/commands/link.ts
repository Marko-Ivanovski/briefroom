import { appendFile, mkdir, readFile, realpath } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type { Context } from '../context.ts';
import { loadCredentials } from '../credentials.ts';
import { CliError } from '../errors.ts';
import { refuseSymlink, writeFileReplacing } from '../fs-safe.ts';
import { excludeFile, repoRoot } from '../git.ts';
import { recordLink } from '../links.ts';

export const LINK_FILE = '.briefroom.json';

interface Choice {
  installId: string;
  baseUrl: string;
  workspaceId: string;
  name: string;
}

async function savedWorkspaces(ctx: Context): Promise<Choice[]> {
  const { installs } = await loadCredentials(ctx.home);
  return Object.entries(installs).flatMap(([baseUrl, install]) =>
    Object.entries(install.workspaces).map(([workspaceId, w]) => ({
      installId: install.installId,
      baseUrl,
      workspaceId,
      name: w.name,
    })),
  );
}

async function pick(ctx: Context, all: Choice[], wanted: string | undefined): Promise<Choice> {
  const matches = wanted
    ? all.filter((c) => c.workspaceId === wanted || c.name.toLowerCase() === wanted.toLowerCase())
    : all;
  if (matches.length === 0) {
    throw new CliError(
      wanted
        ? `No saved workspace matches "${wanted}". Run briefroom login to add it.`
        : 'You are not logged in. Run briefroom login <address> first.',
    );
  }
  if (matches.length === 1) return matches[0]!;
  const labels = matches.map((c) => `${c.name} (${new URL(c.baseUrl).host})`);
  return matches[await ctx.choose('Link this repository to which workspace?', labels)]!;
}

async function addToExclude(cwd: string): Promise<void> {
  const file = await excludeFile(cwd);
  if (!file) throw new CliError('Could not find .git/info/exclude for this repository.');
  await refuseSymlink(file);
  const existing = await readFile(file, 'utf8').catch(() => '');
  if (existing.split(/\r?\n/).includes(LINK_FILE)) return;
  await mkdir(dirname(file), { recursive: true });
  await appendFile(file, `${existing === '' || existing.endsWith('\n') ? '' : '\n'}${LINK_FILE}\n`);
}

/** Writes the repo's link file. It holds ids only: the token stays in the credentials file. */
export async function link(
  ctx: Context,
  options: { workspace?: string; private?: boolean } = {},
): Promise<void> {
  const root = await repoRoot(ctx.cwd);
  if (!root) throw new CliError('Run briefroom link inside a git repository.');

  const chosen = await pick(ctx, await savedWorkspaces(ctx), options.workspace);
  const link = { installId: chosen.installId, workspaceId: chosen.workspaceId };
  if (options.private) await addToExclude(root);
  await writeFileReplacing(join(root, LINK_FILE), `${JSON.stringify(link, null, 2)}\n`, 0o644);
  // The committed file alone never lets the proxy use a token: this machine's own record must agree with it.
  await recordLink(
    ctx.home,
    await realpath(root),
    { baseUrl: chosen.baseUrl, installId: chosen.installId, workspaceId: chosen.workspaceId },
    ctx.now,
  );

  ctx.out(
    `Linked ${basename(root)} to ${chosen.name} on ${new URL(chosen.baseUrl).host}.${
      options.private ? ` ${LINK_FILE} is excluded from git.` : ''
    }\n`,
  );
}

/** The install and workspace this repo is linked to, or null when it is not linked. */
export async function readLink(
  cwd: string,
): Promise<{ installId: string; workspaceId: string } | null> {
  const root = await repoRoot(cwd);
  if (!root) return null;
  try {
    // A symlinked link file is treated as not linked, never read through.
    await refuseSymlink(join(root, LINK_FILE));
    const parsed = JSON.parse(await readFile(join(root, LINK_FILE), 'utf8')) as {
      installId?: unknown;
      workspaceId?: unknown;
    };
    return typeof parsed.installId === 'string' && typeof parsed.workspaceId === 'string'
      ? { installId: parsed.installId, workspaceId: parsed.workspaceId }
      : null;
  } catch {
    return null;
  }
}
