import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { afterEach, describe, expect, it } from 'vitest';
import { run } from '../src/cli.ts';
import { saveCredentials, saveWorkspaceToken } from '../src/credentials.ts';
import { loadLinks, recordLink } from '../src/links.ts';
import { mcpProxy, NOT_LINKED, OFFLINE, OFFLINE_DEADLINE_MS } from '../src/commands/mcp-proxy.ts';
import { realpath } from 'node:fs/promises';
import { MCP_INSTRUCTIONS, SAFETY_SENTENCE } from '../src/instructions.ts';
import { SECRET, testContext, type TestContext } from './helpers.ts';

interface Seen {
  url: string;
  method: string;
  headers: IncomingMessage['headers'];
  body: string;
}

interface Fake {
  baseUrl: string;
  seen: Seen[];
  close(): Promise<void>;
}

const INSTRUCTIONS = 'Briefroom upstream instructions.';

function reply(res: ServerResponse, id: unknown, result: unknown): void {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ jsonrpc: '2.0', id, result }));
}

async function startFake(
  options: { installId?: string; api?: string; redirectMcp?: string; port?: number } = {},
): Promise<Fake> {
  const seen: Seen[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      seen.push({ url: req.url ?? '', method: req.method ?? '', headers: req.headers, body });
      if (req.url === '/api/version') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return void res.end(
          JSON.stringify({ api: options.api ?? '1', installId: options.installId ?? 'inst-1' }),
        );
      }
      if (req.url !== '/mcp') {
        res.writeHead(404);
        return void res.end();
      }
      if (options.redirectMcp) {
        res.writeHead(302, { location: options.redirectMcp });
        return void res.end();
      }
      if (req.method !== 'POST') {
        res.writeHead(405);
        return void res.end();
      }
      const msg = JSON.parse(body) as {
        id?: number;
        method: string;
        params?: { protocolVersion?: string; name?: string; arguments?: unknown };
      };
      if (msg.id === undefined) {
        res.writeHead(202);
        return void res.end();
      }
      switch (msg.method) {
        case 'initialize':
          return reply(res, msg.id, {
            protocolVersion: msg.params?.protocolVersion,
            capabilities: { tools: {} },
            serverInfo: { name: 'fake', version: '1.0.0' },
            instructions: INSTRUCTIONS,
          });
        case 'tools/list':
          return reply(res, msg.id, {
            tools: [
              {
                name: 'briefroom_whoami',
                description: 'Who you are',
                inputSchema: { type: 'object', properties: {} },
              },
            ],
          });
        case 'tools/call':
          return reply(res, msg.id, {
            content: [{ type: 'text', text: 'You are Alice.' }],
          });
        default:
          res.writeHead(200, { 'content-type': 'application/json' });
          return void res.end(
            JSON.stringify({
              jsonrpc: '2.0',
              id: msg.id,
              error: { code: -32601, message: 'Method not found' },
            }),
          );
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(options.port ?? 0, '127.0.0.1', resolve));
  return {
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    seen,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

// Accepts connections and never answers.
async function startBlackHole(): Promise<Fake> {
  const server = createServer(() => undefined);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    seen: [],
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

describe('mcp-proxy', () => {
  const fakes: Fake[] = [];
  const clients: Client[] = [];
  let t: TestContext | undefined;
  let repo: string | undefined;

  afterEach(async () => {
    await Promise.all(clients.splice(0).map((c) => c.close().catch(() => undefined)));
    await Promise.all(fakes.splice(0).map((f) => f.close()));
    await t?.cleanup();
    if (repo) await rm(repo, { recursive: true, force: true });
    t = undefined;
    repo = undefined;
  });

  async function fake(options?: Parameters<typeof startFake>[0]): Promise<Fake> {
    const f = await startFake(options);
    fakes.push(f);
    return f;
  }

  async function setup(): Promise<TestContext> {
    repo = await mkdtemp(join(tmpdir(), 'briefroom-cli-repo-'));
    execFileSync('git', ['init', '-q'], { cwd: repo });
    t = await testContext({ cwd: repo });
    return t;
  }

  async function linkedTo(f: Fake, installId = 'inst-1'): Promise<void> {
    await saveWorkspaceToken(t!.home, { installId, baseUrl: f.baseUrl }, 'ws1', {
      name: 'Acme',
      token: SECRET,
    });
    expect(await run(['link'], t!.ctx)).toBe(0);
  }

  async function connect(options: { offlineMs?: number } = {}): Promise<Client> {
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    void mcpProxy(t!.ctx, { transport: serverSide, ...options });
    const client = new Client({ name: 'test', version: '1.0.0' });
    await client.connect(clientSide);
    clients.push(client);
    return client;
  }

  it('lists the server tools and forwards briefroom_whoami in a linked repo', async () => {
    const f = await fake();
    await setup();
    await linkedTo(f);
    const client = await connect();
    expect((await client.listTools()).tools.map((x) => x.name)).toEqual(['briefroom_whoami']);
    const result = await client.callTool({ name: 'briefroom_whoami', arguments: {} });
    expect(JSON.stringify(result)).toContain('You are Alice.');
    expect(client.getInstructions()).toBe(INSTRUCTIONS);
  });

  it('sends the agent header and the token only to the credential address plus /mcp', async () => {
    const f = await fake();
    await setup();
    await linkedTo(f);
    const client = await connect();
    await client.listTools();
    const calls = f.seen.filter((s) => s.url === '/mcp' && s.method === 'POST');
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call.headers.authorization).toBe(`Bearer ${SECRET}`);
      expect(call.headers['x-briefroom-agent']).toBe('claude-code');
    }
    expect(f.seen.filter((s) => s.url !== '/mcp').every((s) => !s.headers.authorization)).toBe(
      true,
    );
  });

  it('serves no tools and the not-linked message in a repo without .briefroom.json', async () => {
    await setup();
    const client = await connect();
    expect(client.getInstructions()).toBe(`${NOT_LINKED} ${SAFETY_SENTENCE}`);
    expect(NOT_LINKED).toBe(
      'This repo is not linked to a Briefroom workspace. Run briefroom link.',
    );
    expect((await client.listTools()).tools).toEqual([]);
  });

  it('serves no tools when .briefroom.json exists but there is no local link record', async () => {
    const f = await fake();
    await setup();
    await linkedTo(f);
    await rm(join(t!.home, '.briefroom', 'links.json'));
    const client = await connect();
    expect(client.getInstructions()).toBe(`${NOT_LINKED} ${SAFETY_SENTENCE}`);
    expect((await client.listTools()).tools).toEqual([]);
    expect(f.seen.filter((s) => s.url === '/mcp')).toEqual([]);
  });

  it('serves no tools when the record points at a different install than the file', async () => {
    const f = await fake();
    const other = await fake({ installId: 'inst-2' });
    await setup();
    await linkedTo(f);
    await saveWorkspaceToken(t!.home, { installId: 'inst-2', baseUrl: other.baseUrl }, 'ws1', {
      name: 'Other',
      token: `${SECRET}_other`,
    });
    const root = await realpath(repo!);
    await recordLink(t!.home, root, {
      baseUrl: other.baseUrl,
      installId: 'inst-2',
      workspaceId: 'ws1',
    });
    const client = await connect();
    expect(client.getInstructions()).toBe(`${NOT_LINKED} ${SAFETY_SENTENCE}`);
    expect((await client.listTools()).tools).toEqual([]);
    expect(other.seen.filter((s) => s.url === '/mcp')).toEqual([]);
  });

  it('serves no tools when the record has a different workspace than the file', async () => {
    const f = await fake();
    await setup();
    await linkedTo(f);
    await recordLink(t!.home, await realpath(repo!), {
      baseUrl: f.baseUrl,
      installId: 'inst-1',
      workspaceId: 'ws-other',
    });
    const client = await connect();
    expect(client.getInstructions()).toBe(`${NOT_LINKED} ${SAFETY_SENTENCE}`);
    expect((await client.listTools()).tools).toEqual([]);
  });

  it('serves no tools when no credential exists for the recorded address', async () => {
    const f = await fake();
    await setup();
    await linkedTo(f);
    await saveCredentials(t!.home, { installs: {} });
    const client = await connect();
    expect(client.getInstructions()).toBe(`${NOT_LINKED} ${SAFETY_SENTENCE}`);
    expect((await client.listTools()).tools).toEqual([]);
  });

  it('refuses two credential entries that share the linked installId', async () => {
    const f = await fake();
    const twin = await fake();
    await setup();
    await linkedTo(f);
    await saveWorkspaceToken(t!.home, { installId: 'inst-1', baseUrl: twin.baseUrl }, 'ws1', {
      name: 'Twin',
      token: `${SECRET}_twin`,
    });
    const client = await connect();
    expect((await client.listTools()).tools).toEqual([]);
    expect(t!.stderr.join('')).toContain('share the same install id');
    expect(t!.stderr.join('')).not.toContain(SECRET);
    expect([...f.seen, ...twin.seen].filter((s) => s.url === '/mcp')).toEqual([]);
  });

  it('does not follow a redirect from /mcp and never sends the token to its target', async () => {
    const target = await fake();
    const f = await fake({ redirectMcp: `${target.baseUrl}/mcp` });
    await setup();
    await linkedTo(f);
    const client = await connect({ offlineMs: 1500 });
    expect((await client.listTools()).tools).toEqual([]);
    const result = await client.callTool({ name: 'briefroom_whoami', arguments: {} });
    expect(result.isError).toBe(true);
    expect(target.seen).toEqual([]);
  });

  it('refuses to send the token over plain http to a non-local address', async () => {
    await setup();
    await saveCredentials(t!.home, {
      installs: {
        'http://briefroom.example.com': {
          installId: 'inst-1',
          workspaces: { ws1: { name: 'Acme', token: SECRET } },
        },
      },
    });
    await writeFile(
      join(repo!, '.briefroom.json'),
      JSON.stringify({ installId: 'inst-1', workspaceId: 'ws1' }),
    );
    await recordLink(t!.home, await realpath(repo!), {
      baseUrl: 'http://briefroom.example.com',
      installId: 'inst-1',
      workspaceId: 'ws1',
    });
    const client = await connect();
    expect((await client.listTools()).tools).toEqual([]);
    expect(t!.stderr.join('')).toContain('plain http');
  });

  it('serves no tools and says to update the CLI when the API major differs', async () => {
    const f = await fake({ api: '2' });
    await setup();
    await linkedTo(f);
    const client = await connect();
    expect(client.getInstructions()).toBe(
      `This Briefroom install runs API v2. Update the CLI with npm i -g briefroom. ${SAFETY_SENTENCE}`,
    );
    expect((await client.listTools()).tools).toEqual([]);
    expect(f.seen.filter((s) => s.url === '/mcp')).toEqual([]);
  });

  it('refuses an address that reports a different install id than the one saved', async () => {
    const f = await fake({ installId: 'someone-else' });
    await setup();
    await linkedTo(f, 'inst-1');
    const client = await connect();
    expect((await client.listTools()).tools).toEqual([]);
    expect(f.seen.filter((s) => s.url === '/mcp')).toEqual([]);
  });

  it('answers tools/list with no tools within 3 seconds when the host is unreachable', async () => {
    expect(OFFLINE_DEADLINE_MS).toBeLessThanOrEqual(3000);
    const f = await fake();
    await setup();
    await linkedTo(f);
    await f.close();
    fakes.length = 0;
    const started = Date.now();
    const client = await connect();
    expect((await client.listTools()).tools).toEqual([]);
    const result = await client.callTool({ name: 'briefroom_whoami', arguments: {} });
    expect(JSON.stringify(result)).toContain(OFFLINE);
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it('answers within the deadline when the host accepts connections and never replies', async () => {
    const hole = await startBlackHole();
    fakes.push(hole);
    await setup();
    await saveWorkspaceToken(t!.home, { installId: 'inst-1', baseUrl: hole.baseUrl }, 'ws1', {
      name: 'Acme',
      token: SECRET,
    });
    await writeFile(
      join(repo!, '.briefroom.json'),
      JSON.stringify({ installId: 'inst-1', workspaceId: 'ws1' }),
    );
    await recordLink(t!.home, await realpath(repo!), {
      baseUrl: hole.baseUrl,
      installId: 'inst-1',
      workspaceId: 'ws1',
    });
    const started = Date.now();
    const client = await connect({ offlineMs: 300 });
    expect((await client.listTools()).tools).toEqual([]);
    const result = await client.callTool({ name: 'briefroom_whoami', arguments: {} });
    expect(JSON.stringify(result)).toContain(OFFLINE);
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it('lists no tools after the host goes away mid-session', async () => {
    const f = await fake();
    await setup();
    await linkedTo(f);
    const client = await connect();
    expect((await client.listTools()).tools).toHaveLength(1);
    await f.close();
    fakes.length = 0;
    expect((await client.listTools()).tools).toEqual([]);
  });

  it('writes nothing from requests or results to stderr', async () => {
    const f = await fake();
    await setup();
    await linkedTo(f);
    t!.stdout.length = 0;
    t!.stderr.length = 0;
    const client = await connect();
    await client.listTools();
    await client.callTool({ name: 'briefroom_whoami', arguments: { note: 'ARG-MARKER-42' } });
    const err = t!.stderr.join('');
    expect(err).not.toContain('ARG-MARKER-42');
    expect(err).not.toContain('You are Alice.');
    expect(err).not.toContain(SECRET);
    expect(t!.stdout.join('')).toBe('');
  });

  it('keeps the CLI instructions identical to the API ones', async () => {
    const api = await readFile(
      join(import.meta.dirname, '..', '..', 'api', 'src', 'mcp', 'core.tools.ts'),
      'utf8',
    );
    const match = /export const MCP_INSTRUCTIONS =\s*"([^\n]*)";/.exec(api);
    expect(match).not.toBeNull();
    expect(match![1]).toBe(MCP_INSTRUCTIONS);
    expect(MCP_INSTRUCTIONS.endsWith(SAFETY_SENTENCE)).toBe(true);
  });

  it('answers initialize, tools/list and tools/call within 3.2 s each against a hanging host (default deadline, real timers)', async () => {
    const hole = await startBlackHole();
    fakes.push(hole);
    await setup();
    await saveWorkspaceToken(t!.home, { installId: 'inst-1', baseUrl: hole.baseUrl }, 'ws1', {
      name: 'Acme',
      token: SECRET,
    });
    await writeFile(
      join(repo!, '.briefroom.json'),
      JSON.stringify({ installId: 'inst-1', workspaceId: 'ws1' }),
    );
    await recordLink(t!.home, await realpath(repo!), {
      baseUrl: hole.baseUrl,
      installId: 'inst-1',
      workspaceId: 'ws1',
    });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    void mcpProxy(t!.ctx, { transport: serverSide });
    const client = new Client({ name: 'test', version: '1.0.0' });
    clients.push(client);

    let mark = Date.now();
    await client.connect(clientSide);
    expect(Date.now() - mark).toBeLessThan(3200);
    expect(client.getInstructions()).toContain(SAFETY_SENTENCE);
    expect(client.getInstructions()).toContain(OFFLINE);

    mark = Date.now();
    expect((await client.listTools()).tools).toEqual([]);
    expect(Date.now() - mark).toBeLessThan(3200);

    mark = Date.now();
    const result = await client.callTool({ name: 'briefroom_whoami', arguments: {} });
    expect(JSON.stringify(result)).toContain(OFFLINE);
    expect(Date.now() - mark).toBeLessThan(3200);
  }, 20_000);

  it('starts offline with the safety instructions, then recovers and announces the tools', async () => {
    const first = await fake();
    await setup();
    await linkedTo(first);
    const port = Number(new URL(first.baseUrl).port);
    await first.close();
    fakes.length = 0;

    const client = new Client({ name: 'test', version: '1.0.0' });
    const changed = new Promise<void>((resolve) => {
      client.setNotificationHandler('notifications/tools/list_changed', () => resolve());
    });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    void mcpProxy(t!.ctx, { transport: serverSide });
    await client.connect(clientSide);
    clients.push(client);
    expect(client.getInstructions()).toBe(`${MCP_INSTRUCTIONS} ${OFFLINE}`);
    expect((await client.listTools()).tools).toEqual([]);

    fakes.push(await startFake({ port }));
    const result = await client.callTool({ name: 'briefroom_whoami', arguments: {} });
    expect(JSON.stringify(result)).toContain('You are Alice.');
    await changed;
    expect((await client.listTools()).tools.map((x) => x.name)).toEqual(['briefroom_whoami']);
  });

  describe('local link record', () => {
    it('is written by link with the real path, address, workspace and time, mode 600', async () => {
      const f = await fake();
      await setup();
      await linkedTo(f);
      const file = join(t!.home, '.briefroom', 'links.json');
      const { links } = await loadLinks(t!.home);
      const entry = links[await realpath(repo!)];
      expect(entry).toMatchObject({ baseUrl: f.baseUrl, installId: 'inst-1', workspaceId: 'ws1' });
      expect(Number.isNaN(Date.parse(entry!.linkedAt))).toBe(false);
      expect(await readFile(file, 'utf8')).not.toContain(SECRET);
      if (process.platform !== 'win32') expect((await stat(file)).mode & 0o777).toBe(0o600);
    });

    it('refuses to write through a symlinked links.json', async () => {
      const f = await fake();
      await setup();
      await saveWorkspaceToken(t!.home, { installId: 'inst-1', baseUrl: f.baseUrl }, 'ws1', {
        name: 'Acme',
        token: SECRET,
      });
      const decoy = join(t!.home, 'decoy.json');
      await writeFile(decoy, 'keep');
      try {
        await symlink(decoy, join(t!.home, '.briefroom', 'links.json'));
      } catch {
        return;
      }
      expect(await run(['link'], t!.ctx)).toBe(1);
      expect(await readFile(decoy, 'utf8')).toBe('keep');
    });

    it('is removed by disconnect', async () => {
      const f = await fake();
      await setup();
      await linkedTo(f);
      expect(Object.keys((await loadLinks(t!.home)).links)).toHaveLength(1);
      expect(await run(['disconnect'], t!.ctx)).toBe(0);
      expect((await loadLinks(t!.home)).links).toEqual({});
    });
  });
});
