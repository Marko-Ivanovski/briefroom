import { realpath } from 'node:fs/promises';
import {
  Client,
  ProtocolError,
  SdkHttpError,
  StreamableHTTPClientTransport,
  UnauthorizedError,
  type CallToolResult,
  type Transport,
} from '@modelcontextprotocol/client';
import { Server } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import pkg from '../../package.json' with { type: 'json' };
import { assertCompatible, normaliseAddress } from '../api.ts';
import type { Context } from '../context.ts';
import { loadCredentials } from '../credentials.ts';
import { CliError } from '../errors.ts';
import { repoRoot } from '../git.ts';
import { loadLinks } from '../links.ts';
import { readLink } from './link.ts';

export const NOT_LINKED = 'This repo is not linked to a Briefroom workspace. Run briefroom link.';
export const OFFLINE = 'Briefroom is offline.';
export const OFFLINE_DEADLINE_MS = 3000;
const CALL_TIMEOUT_MS = 60_000;
const AGENT = 'claude-code';

interface Target {
  baseUrl: string;
  token: string;
  installId: string;
}

type Resolution = { target: Target } | { message: string };

function status(ctx: Context, text: string): void {
  ctx.err(`briefroom mcp-proxy: ${text}\n`);
}

/**
 * A repo gets tools only when the committed .briefroom.json, this machine's own link record and a
 * saved credential all agree. The address the token goes to comes from the credential, never from the repo.
 */
async function resolveTarget(ctx: Context): Promise<Resolution> {
  const none = { message: NOT_LINKED };
  const link = await readLink(ctx.cwd);
  const root = await repoRoot(ctx.cwd);
  if (!link || !root) return none;

  let record;
  let installs;
  try {
    record = (await loadLinks(ctx.home)).links[await realpath(root)];
    installs = (await loadCredentials(ctx.home)).installs;
  } catch (err) {
    status(ctx, `could not read saved logins. ${(err as Error).message}`);
    return none;
  }
  if (record?.workspaceId !== link.workspaceId || record.installId !== link.installId) return none;
  const install = installs[record.baseUrl];
  const credential = install?.workspaces[link.workspaceId];
  if (install?.installId !== link.installId || !credential) return none;

  const sharing = Object.values(installs).filter((i) => i.installId === link.installId);
  if (sharing.length > 1) {
    status(ctx, 'two saved logins share the same install id, so no tools are served.');
    return {
      message:
        'Two saved Briefroom logins share one install id. Run briefroom disconnect --all, then briefroom login.',
    };
  }

  try {
    if (normaliseAddress(record.baseUrl) !== record.baseUrl) throw new CliError(NOT_LINKED);
  } catch (err) {
    status(ctx, (err as Error).message);
    return none;
  }
  return {
    target: { baseUrl: record.baseUrl, token: credential.token, installId: install.installId },
  };
}

class Refused extends Error {}

function describeFailure(err: unknown): string {
  if (err instanceof UnauthorizedError || (err instanceof SdkHttpError && err.status === 401)) {
    return 'Briefroom refused the saved token. Run briefroom login.';
  }
  if (err instanceof SdkHttpError) return `Briefroom answered HTTP ${err.status}.`;
  return OFFLINE;
}

/** One lazily opened connection to the install. A failed request drops it, so the next call retries. */
class Upstream {
  private client: Client | null = null;
  private pending: Promise<Client> | null = null;

  constructor(
    private readonly ctx: Context,
    private readonly target: Target,
    private readonly deadlineMs: number,
  ) {}

  acquire(): Promise<Client> {
    if (this.client) return Promise.resolve(this.client);
    this.pending ??= this.open().finally(() => {
      this.pending = null;
    });
    return this.pending;
  }

  async drop(): Promise<void> {
    const client = this.client;
    this.client = null;
    await client?.close().catch(() => undefined);
  }

  private async open(): Promise<Client> {
    const { baseUrl, token, installId } = this.target;
    const timed: Context = {
      ...this.ctx,
      fetch: (input, init) =>
        this.ctx.fetch(input, { ...init, signal: AbortSignal.timeout(this.deadlineMs) }),
    };
    let reported: string | null;
    try {
      reported = await assertCompatible(timed, baseUrl);
    } catch (err) {
      if (err instanceof CliError && err.exitCode === 2) throw new Refused(err.message);
      throw new Refused(OFFLINE);
    }
    if (reported !== installId) {
      throw new Refused(
        `${new URL(baseUrl).host} is a different Briefroom install than the one you logged in to. Run briefroom login.`,
      );
    }

    const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
      fetch: this.ctx.fetch,
      // A redirect is never followed: the Bearer header must not leave the address it was saved for.
      requestInit: {
        redirect: 'manual',
        headers: { authorization: `Bearer ${token}`, 'x-briefroom-agent': AGENT },
      },
    });
    const client = new Client({ name: 'briefroom-mcp-proxy', version: pkg.version });
    const signal = AbortSignal.timeout(this.deadlineMs);
    try {
      await within(
        this.deadlineMs,
        client.connect(transport, { signal, timeout: this.deadlineMs }),
      );
    } catch (err) {
      await client.close().catch(() => undefined);
      throw new Refused(describeFailure(err));
    }
    this.client = client;
    return client;
  }
}

function within<T>(ms: number, work: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('deadline')), ms);
  });
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
}

function refusal(text: string): CallToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}

export interface McpProxyOptions {
  /** Defaults to stdio. Tests pass one end of an in-memory pair. */
  transport?: Transport;
  offlineMs?: number;
}

/**
 * Stdio MCP server that Claude Code launches. It forwards tools to the linked install's /mcp and
 * never logs request or response content: stderr only gets status lines.
 */
export async function mcpProxy(ctx: Context, options: McpProxyOptions = {}): Promise<void> {
  const deadlineMs = options.offlineMs ?? OFFLINE_DEADLINE_MS;
  const resolved = await resolveTarget(ctx);
  const upstream = 'target' in resolved ? new Upstream(ctx, resolved.target, deadlineMs) : null;

  let instructions: string | undefined = 'message' in resolved ? resolved.message : undefined;
  if (upstream) {
    try {
      instructions = (await upstream.acquire()).getInstructions();
      status(ctx, `connected to ${new URL((resolved as { target: Target }).target.baseUrl).host}.`);
    } catch (err) {
      instructions = err instanceof Refused && err.message !== OFFLINE ? err.message : undefined;
      status(ctx, 'the install is not reachable right now. Each call will retry.');
    }
  }

  const server = new Server(
    { name: 'briefroom', version: pkg.version },
    { capabilities: { tools: {} }, ...(instructions === undefined ? {} : { instructions }) },
  );

  server.setRequestHandler('tools/list', async () => {
    if (!upstream) return { tools: [] };
    try {
      const client = await upstream.acquire();
      const signal = AbortSignal.timeout(deadlineMs);
      return await within(deadlineMs, client.listTools(undefined, { signal, cacheMode: 'bypass' }));
    } catch {
      await upstream.drop();
      return { tools: [] };
    }
  });

  server.setRequestHandler('tools/call', async (request) => {
    if (!upstream)
      return refusal(resolved && 'message' in resolved ? resolved.message : NOT_LINKED);
    let client: Client;
    try {
      client = await upstream.acquire();
    } catch (err) {
      return refusal(err instanceof Refused ? err.message : OFFLINE);
    }
    try {
      return (await client.callTool(
        { name: request.params.name, arguments: request.params.arguments },
        { timeout: CALL_TIMEOUT_MS },
      )) as CallToolResult;
    } catch (err) {
      // An error the install itself answered with stays as it is. Anything else means the link is gone.
      if (err instanceof ProtocolError) throw err;
      await upstream.drop();
      return refusal(describeFailure(err));
    }
  });

  const closed = new Promise<void>((resolve) => {
    server.onclose = resolve;
  });
  await server.connect(options.transport ?? new StdioServerTransport());
  await closed;
  await upstream?.drop();
}
