import { assertCompatible, request } from '../api.ts';
import type { Context } from '../context.ts';
import { loadCredentials, removeWorkspaceToken } from '../credentials.ts';
import { CliError } from '../errors.ts';
import { readLink } from './link.ts';

interface Target {
  installId: string;
  baseUrl: string;
  workspaceId: string;
  name: string;
  token: string;
}

async function targets(ctx: Context, all: boolean): Promise<Target[]> {
  const { installs } = await loadCredentials(ctx.home);
  const every = Object.entries(installs).flatMap(([installId, install]) =>
    Object.entries(install.workspaces).map(([workspaceId, w]) => ({
      installId,
      baseUrl: install.baseUrl,
      workspaceId,
      name: w.name,
      token: w.token,
    })),
  );
  if (all || every.length <= 1) return every;
  const linked = await readLink(ctx.cwd);
  const own = linked
    ? every.filter((t) => t.installId === linked.installId && t.workspaceId === linked.workspaceId)
    : [];
  if (own.length === 0) {
    throw new CliError(
      'Several workspaces are saved. Run briefroom disconnect inside a linked repository, or use --all.',
    );
  }
  return own;
}

/**
 * Revokes the token on the install, then removes it locally. The local copy goes even when the
 * server cannot be reached: a token that is still stored can leak, a failed revoke is only warned about.
 */
export async function disconnect(ctx: Context, options: { all?: boolean } = {}): Promise<void> {
  const list = await targets(ctx, options.all === true);
  if (list.length === 0) {
    ctx.out('Nothing to disconnect.\n');
    return;
  }
  let outdated: CliError | null = null;
  for (const target of list) {
    const host = new URL(target.baseUrl).host;
    try {
      await assertCompatible(ctx, target.baseUrl);
      const res = await request(ctx, target.baseUrl, '/api/v1/tokens/self', {
        method: 'DELETE',
        token: target.token,
      });
      // 401 means the token was already revoked or removed, which is the state we want.
      if (!res.ok && res.status !== 401) {
        ctx.err(
          `Warning: ${host} answered HTTP ${res.status}. The token may still be active there.\n`,
        );
      }
    } catch (err) {
      if (!(err instanceof CliError)) throw err;
      if (err.exitCode === 2) outdated = err;
      ctx.err(`Warning: could not revoke the token on ${host}. ${err.message}\n`);
    }
    await removeWorkspaceToken(ctx.home, target.installId, target.workspaceId);
    ctx.out(`Disconnected from ${target.name} on ${host}.\n`);
  }
  if (outdated) throw outdated;
}
