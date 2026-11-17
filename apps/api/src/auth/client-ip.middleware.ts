import { BlockList, isIP } from 'node:net';
import type { IncomingMessage, ServerResponse } from 'node:http';

export const CLIENT_IP_HEADER = 'x-briefroom-client-ip';

const MAPPED_V4 = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i;

/** Reports an IPv4-mapped IPv6 address (`::ffff:1.2.3.4`) as plain IPv4. */
function normalize(address: string): string {
  return MAPPED_V4.exec(address)?.[1] ?? address;
}

/** Whether `entry` is an IP address or a CIDR range, the two forms BRIEFROOM_TRUSTED_PROXIES takes. */
export function isProxyEntry(entry: string): boolean {
  const [address = '', prefix, ...rest] = entry.split('/');
  const family = isIP(address);
  if (family === 0 || rest.length > 0) return false;
  if (prefix === undefined) return true;
  return /^\d{1,3}$/.test(prefix) && Number(prefix) <= (family === 4 ? 32 : 128);
}

function trustList(entries: readonly string[]): BlockList {
  const list = new BlockList();
  for (const entry of entries) {
    const [address = '', prefix] = entry.split('/');
    const family = isIP(address) === 4 ? 'ipv4' : 'ipv6';
    if (prefix === undefined) list.addAddress(normalize(address), family);
    else list.addSubnet(normalize(address), Number(prefix), family);
  }
  return list;
}

/**
 * Sets the client address that rate limits and audit rows key on. Forwarded headers are believed
 * only from a trusted socket, and the rightmost address that is not itself trusted wins, so a
 * value the client prepends to X-Forwarded-For never counts. Any incoming value of our own header
 * is overwritten.
 */
export function createClientIpMiddleware(trustedProxies: readonly string[]) {
  const trusted = trustList(trustedProxies);
  const isTrusted = (address: string): boolean => {
    const family = isIP(address);
    return family !== 0 && trusted.check(address, family === 4 ? 'ipv4' : 'ipv6');
  };

  return (req: IncomingMessage, _res: ServerResponse, next: () => void): void => {
    const socket = normalize(req.socket.remoteAddress ?? '');
    req.headers[CLIENT_IP_HEADER] = isTrusted(socket)
      ? forwardedClient(req, socket, isTrusted)
      : socket;
    next();
  };
}

function forwardedClient(
  req: IncomingMessage,
  socket: string,
  isTrusted: (address: string) => boolean,
): string {
  const header = req.headers['x-forwarded-for'];
  const hops = (Array.isArray(header) ? header.join(',') : (header ?? ''))
    .split(',')
    .map((hop) => normalize(hop.trim()))
    .filter((hop) => hop !== '');
  if (hops.length === 0) return socket;

  for (let i = hops.length - 1; i >= 0; i--) {
    const hop = hops[i]!;
    if (isIP(hop) === 0) return socket;
    if (!isTrusted(hop)) return hop;
  }
  return hops[0]!;
}
