import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const plugin = join(import.meta.dirname, '..', '..', '..', 'plugins', 'claude-code');

describe('claude code plugin', () => {
  it('declares the briefroom server as `briefroom mcp-proxy` and nothing secret or personal', async () => {
    const raw = await readFile(join(plugin, '.mcp.json'), 'utf8');
    expect(JSON.parse(raw)).toEqual({
      mcpServers: { briefroom: { command: 'briefroom', args: ['mcp-proxy'] } },
    });
    expect(raw).not.toMatch(/brf_|[A-Za-z]:\\|\/Users\/|\/home\/|https?:\/\//);
  });

  it('has a manifest with the required name', async () => {
    const manifest = JSON.parse(
      await readFile(join(plugin, '.claude-plugin', 'plugin.json'), 'utf8'),
    ) as { name: string };
    expect(manifest.name).toBe('briefroom');
  });
});
