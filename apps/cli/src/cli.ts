import { Command, CommanderError } from 'commander';
import pkg from '../package.json' with { type: 'json' };
import { disconnect } from './commands/disconnect.ts';
import { init, type InitOptions } from './commands/init.ts';
import { link } from './commands/link.ts';
import { login } from './commands/login.ts';
import { mcpProxy } from './commands/mcp-proxy.ts';
import { resetPassword } from './commands/reset-password.ts';
import type { Context } from './context.ts';
import { CliError } from './errors.ts';

export function buildProgram(ctx: Context): Command {
  const program = new Command()
    .name('briefroom')
    .description('Connect coding agents to a Briefroom install.')
    .version(pkg.version)
    .exitOverride()
    .configureOutput({ writeOut: ctx.out, writeErr: ctx.err });

  program
    .command('init')
    .description('Set up a Briefroom install: writes .env and downloads the Compose files')
    .argument('[dir]', 'folder for the install, default ./briefroom')
    .option('-y, --yes', 'ask nothing and use the defaults and flags')
    .option('--port <port>', 'port the app listens on, default 4300')
    .option('--lan', 'let other devices on the local network reach it, through Caddy over https')
    .option('--local', 'only this computer can reach it')
    .option(
      '--host <host>',
      'address other devices use, with --lan. Default: the first LAN address of this machine',
    )
    .action((dir: string | undefined, opts: InitOptions) => init(ctx, dir, opts));

  program
    .command('reset-password')
    .description(
      'Print a password reset link for an account, run on the machine that hosts Briefroom',
    )
    .argument('<email>', 'email of the account')
    .option('--dir <dir>', 'install folder that holds compose.yml, default the current folder')
    .action((email: string, opts: { dir?: string }) => resetPassword(ctx, email, opts));

  program
    .command('login')
    .description('Sign in to an install through your browser')
    .argument('<address>', 'address of the install, for example briefroom.example.com')
    .option('--no-browser', 'print the approval address without opening a browser')
    .action((address: string, opts: { browser: boolean }) => login(ctx, address, opts));

  program
    .command('link')
    .description('Link this git repository to a workspace')
    .option('--workspace <name-or-id>', 'workspace to link, when several are saved')
    .option('--private', 'keep .briefroom.json out of git through .git/info/exclude')
    .action((opts: { workspace?: string; private?: boolean }) => link(ctx, opts));

  program
    .command('disconnect')
    .description('Revoke the saved token and remove it from this machine')
    .option('--all', 'disconnect every saved workspace on every install')
    .action((opts: { all?: boolean }) => disconnect(ctx, opts));

  program
    .command('mcp-proxy')
    .description('Run the MCP server that coding agents launch (stdio)')
    .action(() => mcpProxy(ctx));

  return program;
}

/** Runs the CLI and returns its exit code. Only the entry point sets process.exitCode. */
export async function run(argv: string[], ctx: Context): Promise<number> {
  try {
    await buildProgram(ctx).parseAsync(argv, { from: 'user' });
    return 0;
  } catch (err) {
    if (err instanceof CliError) {
      ctx.err(`${err.message}\n`);
      return err.exitCode;
    }
    // Commander has already printed its own usage message.
    if (err instanceof CommanderError) return err.exitCode;
    ctx.err(`Unexpected error: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}
