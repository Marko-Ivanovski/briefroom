import { Command, CommanderError } from 'commander';
import pkg from '../package.json' with { type: 'json' };
import { disconnect } from './commands/disconnect.ts';
import { link } from './commands/link.ts';
import { login } from './commands/login.ts';
import { mcpProxy } from './commands/mcp-proxy.ts';
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
