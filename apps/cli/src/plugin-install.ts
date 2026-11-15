import pkg from '../package.json' with { type: 'json' };
import type { Context } from './context.ts';

// Must match .claude-plugin/marketplace.json and plugins/claude-code/.claude-plugin/plugin.json.
export const MARKETPLACE_NAME = 'briefroom';
export const PLUGIN_NAME = 'briefroom';
const FALLBACK_SOURCE = 'https://github.com/Marko-Ivanovski/briefroom.git';

function marketplaceSource(): string {
  const repository = (pkg as { repository?: { url?: string } | string }).repository;
  const url = typeof repository === 'string' ? repository : repository?.url;
  return url ? url.replace(/^git\+/, '') : FALLBACK_SOURCE;
}

/** Offers to add the Claude Code plugin. Nothing here can fail a login. */
export async function offerPlugin(ctx: Context): Promise<void> {
  const commands: [string, string[]][] = [
    ['claude', ['plugin', 'marketplace', 'add', marketplaceSource()]],
    ['claude', ['plugin', 'install', `${PLUGIN_NAME}@${MARKETPLACE_NAME}`]],
  ];
  const printCommands = (): void =>
    ctx.out(
      `To add the Claude Code plugin, run:\n${commands.map(([f, a]) => `  ${f} ${a.join(' ')}\n`).join('')}`,
    );

  if (
    !ctx.interactive ||
    !(await ctx.hasCommand('claude')) ||
    !(await ctx.confirm('Install the Briefroom plugin for Claude Code? [y/N]'))
  ) {
    printCommands();
    return;
  }
  try {
    for (const [file, args] of commands) await ctx.exec(file, args);
    ctx.out('Installed the Briefroom plugin for Claude Code.\n');
  } catch (err) {
    ctx.err(`Warning: the plugin was not installed. ${(err as Error).message}\n`);
    printCommands();
  }
}
