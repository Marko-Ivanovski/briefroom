import { stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Context } from '../context.ts';
import { CliError } from '../errors.ts';

const ADMIN_CLI = 'apps/api/dist/admin-cli.js';

export async function resetPassword(
  ctx: Context,
  email: string,
  options: { dir?: string },
): Promise<void> {
  const dir = resolve(ctx.cwd, options.dir ?? '.');
  const hasCompose = await stat(join(dir, 'compose.yml')).then(
    (s) => s.isFile(),
    () => false,
  );
  if (!hasCompose) {
    throw new CliError(
      `No compose.yml in ${dir}. Run this in the install folder or pass --dir <folder>.`,
    );
  }
  const docker = ctx.resolveCommand('docker');
  if (!docker) throw new CliError('Docker was not found on PATH. Install Docker and try again.');

  // -T because no terminal is needed, and the link must print as plain output.
  const code = await ctx.runInherited(
    docker,
    ['compose', 'exec', '-T', 'app', 'node', ADMIN_CLI, 'reset-password', email],
    dir,
  );
  if (code !== 0)
    throw new CliError('The reset failed. Is Briefroom running (docker compose up -d)?', code);
}
