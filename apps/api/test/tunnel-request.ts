import { randomBytes } from 'node:crypto';
import { request, type IncomingHttpHeaders } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** A fresh socket path per app, so parallel test files never share one. */
export function testTunnelSocket(): string {
  const id = randomBytes(6).toString('hex');
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\briefroom-test-${id}`
    : join(tmpdir(), `briefroom-test-${id}.sock`);
}

export interface TunnelResponse {
  status: number;
  headers: IncomingHttpHeaders;
  text: string;
  // Parsed JSON, loosely typed like supertest's body.
  body: any; // eslint-disable-line @typescript-eslint/no-explicit-any
}

/** Sends one request the way cloudflared or tailscale serve would: over the tunnel socket. */
export function viaTunnel(
  socketPath: string,
  method: string,
  path: string,
  options: { headers?: Record<string, string>; body?: unknown } = {},
): Promise<TunnelResponse> {
  const payload = options.body === undefined ? undefined : JSON.stringify(options.body);
  return new Promise((resolve, reject) => {
    const req = request(
      {
        socketPath,
        method,
        path,
        headers: {
          ...(payload === undefined
            ? {}
            : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }),
          ...options.headers,
        },
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => (text += chunk));
        res.on('end', () => {
          let body: unknown = {};
          try {
            body = JSON.parse(text);
          } catch {
            // Not JSON: leave the body empty, as supertest does.
          }
          resolve({ status: res.statusCode ?? 0, headers: res.headers, text, body });
        });
      },
    );
    req.on('error', reject);
    req.end(payload);
  });
}
