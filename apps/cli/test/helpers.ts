import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Context } from '../src/context.ts';

export interface Recorded {
  method: string;
  url: string;
  authorization: string | undefined;
  body: unknown;
}

export type Handler = (req: Recorded, res: ServerResponse) => void;

export interface Stub {
  baseUrl: string;
  requests: Recorded[];
  close(): Promise<void>;
}

export function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw === '' ? undefined : JSON.parse(raw);
}

export async function startStub(handler: Handler): Promise<Stub> {
  const requests: Recorded[] = [];
  const server: Server = createServer((req, res) => {
    void readBody(req).then((body) => {
      const recorded = {
        method: req.method ?? 'GET',
        url: req.url ?? '/',
        authorization: req.headers.authorization,
        body,
      };
      requests.push(recorded);
      handler(recorded, res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

export interface TestContext {
  ctx: Context;
  stdout: string[];
  stderr: string[];
  opened: string[];
  home: string;
  cleanup(): Promise<void>;
}

export async function testContext(overrides: Partial<Context> = {}): Promise<TestContext> {
  const home = await mkdtemp(join(tmpdir(), 'briefroom-cli-home-'));
  const stdout: string[] = [];
  const stderr: string[] = [];
  const opened: string[] = [];
  const ctx: Context = {
    home,
    cwd: home,
    hostname: 'test-laptop',
    fetch: globalThis.fetch,
    out: (t) => void stdout.push(t),
    err: (t) => void stderr.push(t),
    openUrl: (url) => {
      opened.push(url);
      return Promise.resolve();
    },
    sleep: () => Promise.resolve(),
    now: () => Date.now(),
    choose: () => Promise.reject(new Error('choose was not expected')),
    interactive: false,
    confirm: () => Promise.reject(new Error('confirm was not expected')),
    ask: () => Promise.reject(new Error('ask was not expected')),
    networkInterfaces: () => ({}),
    exec: () => Promise.reject(new Error('exec was not expected')),
    runInherited: () => Promise.reject(new Error('runInherited was not expected')),
    resolveCommand: () => null,
    ...overrides,
  };
  return {
    ctx,
    stdout,
    stderr,
    opened,
    home,
    cleanup: () => rm(home, { recursive: true, force: true }),
  };
}

export const SECRET = 'brf_secret_token_value';
