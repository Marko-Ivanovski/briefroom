import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer, request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { listenOnTunnelSocket, tryListenOnTunnelSocket } from '../src/auth/proxy-socket.ts';
import { testTunnelSocket } from './tunnel-request.ts';

const windows = process.platform === 'win32';

describe('tunnel socket', () => {
  const servers: { close(): unknown }[] = [];
  const folders: string[] = [];
  const http = () => {
    const server = createServer((_req, res) => res.end('ok'));
    servers.push(server);
    return server;
  };
  const folder = () => {
    const dir = mkdtempSync(join(tmpdir(), 'briefroom-sock-'));
    folders.push(dir);
    return dir;
  };

  afterEach(() => {
    for (const s of servers.splice(0)) s.close();
    for (const dir of folders.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  const get = (socketPath: string) =>
    new Promise<number>((resolve, reject) => {
      request({ socketPath, path: '/' }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      })
        .on('error', reject)
        .end();
    });

  it.skipIf(windows)('removes a stale socket file left by a crashed run', async () => {
    const path = join(folder(), 'run', 'tunnel.sock');
    mkdirSync(join(path, '..'));
    writeFileSync(path, 'stale');
    const server = await listenOnTunnelSocket(http(), path);
    servers.push(server);
    expect(statSync(path).isSocket()).toBe(true);
    expect(await get(path)).toBe(200);
  });

  it.skipIf(windows)('tightens a folder that already exists with a looser mode', async () => {
    const dir = join(folder(), 'run');
    mkdirSync(dir, { mode: 0o755 });
    const server = await listenOnTunnelSocket(http(), join(dir, 'tunnel.sock'));
    servers.push(server);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(join(dir, 'tunnel.sock')).mode & 0o777).toBe(0o600);
  });

  it('answers requests that arrive on the socket', async () => {
    const path = windows ? testTunnelSocket() : join(folder(), 'tunnel.sock');
    const server = await listenOnTunnelSocket(http(), path);
    servers.push(server);
    expect(await get(path)).toBe(200);
  });

  it('reports a listen failure and resolves instead of throwing', async () => {
    const onError = vi.fn();
    let path: string;
    if (windows) {
      path = testTunnelSocket();
      const taken = await listenOnTunnelSocket(http(), path);
      servers.push(taken);
    } else {
      path = join(folder(), 'tunnel.sock');
      mkdirSync(path);
    }
    await expect(tryListenOnTunnelSocket(http(), path, onError)).resolves.toBeNull();
    expect(onError).toHaveBeenCalledOnce();
  });

  it('reports a path that is too long for a socket', async () => {
    const onError = vi.fn();
    const path = join(folder(), 'x'.repeat(300), 'tunnel.sock');
    await expect(tryListenOnTunnelSocket(http(), path, onError)).resolves.toBeNull();
    expect(onError).toHaveBeenCalledOnce();
  });
});
