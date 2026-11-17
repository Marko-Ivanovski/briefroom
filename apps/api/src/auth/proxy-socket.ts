import { chmodSync, mkdirSync, rmSync } from 'node:fs';
import type { IncomingMessage, Server as HttpServer } from 'node:http';
import { createServer, type Server, type Socket } from 'node:net';
import { dirname } from 'node:path';

// Connections accepted on the tunnel socket. Only these may carry forwarded headers we believe.
const tunnelSockets = new WeakSet<Socket>();

export function cameThroughTunnel(req: IncomingMessage): boolean {
  return tunnelSockets.has(req.socket as Socket);
}

const isWindowsPipe = (path: string) => path.startsWith('\\');

/**
 * A second listener for cloudflared and tailscale serve, on a Unix socket only this user can open.
 * Its connections are handed to the app's own HTTP server, tagged, so they share every handler,
 * timeout and middleware. Closed together with the HTTP server.
 */
export async function listenOnTunnelSocket(httpServer: HttpServer, path: string): Promise<Server> {
  if (!isWindowsPipe(path)) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    rmSync(path, { force: true });
  }
  const server = createServer((socket) => {
    tunnelSockets.add(socket);
    httpServer.emit('connection', socket);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, () => {
      server.off('error', reject);
      resolve();
    });
  });
  if (!isWindowsPipe(path)) chmodSync(path, 0o600);
  httpServer.once('close', () => server.close());
  return server;
}
