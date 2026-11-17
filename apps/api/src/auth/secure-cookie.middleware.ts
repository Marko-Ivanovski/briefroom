import type { IncomingMessage, ServerResponse } from 'node:http';
import { CLIENT_PROTO_HEADER } from './client-ip.middleware.ts';

const SECURE = /;\s*secure\s*(;|$)/i;

const markSecure = (cookie: string): string => (SECURE.test(cookie) ? cookie : `${cookie}; Secure`);

function withSecure<T extends number | string | readonly string[]>(
  value: T,
): T | string | string[] {
  if (typeof value === 'number') return value;
  return typeof value === 'string' ? markSecure(value) : value.map(markSecure);
}

/**
 * Better Auth decides Secure once, from BRIEFROOM_PUBLIC_URL. A request that reached us over https
 * through a trusted hop (a tunnel or a reverse proxy) gets Secure on every cookie as well. The cookie
 * names stay the same, so the same session works on the plain http LAN address.
 */
export function secureCookieMiddleware(
  req: IncomingMessage,
  res: ServerResponse,
  next: () => void,
): void {
  if (req.headers[CLIENT_PROTO_HEADER] === 'https') {
    const setHeader = res.setHeader.bind(res);
    res.setHeader = (name, value) =>
      setHeader(name, name.toLowerCase() === 'set-cookie' ? withSecure(value) : value);
    const appendHeader = res.appendHeader.bind(res);
    res.appendHeader = (name, value) =>
      appendHeader(name, name.toLowerCase() === 'set-cookie' ? withSecure(value) : value);
  }
  next();
}
