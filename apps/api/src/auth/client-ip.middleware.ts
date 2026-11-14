import type { IncomingMessage, ServerResponse } from 'node:http';

export const CLIENT_IP_HEADER = 'x-briefroom-client-ip';

// Story 8 will extend this to trust forwarded headers from configured proxies only.
export function clientIpMiddleware(
  req: IncomingMessage,
  _res: ServerResponse,
  next: () => void,
): void {
  req.headers[CLIENT_IP_HEADER] = req.socket.remoteAddress ?? '';
  next();
}
