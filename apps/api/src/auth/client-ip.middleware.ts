import { BlockList, isIP } from 'node:net';
import type { IncomingMessage, ServerResponse } from 'node:http';

export const CLIENT_IP_HEADER = 'x-briefroom-client-ip';
/** `https` only when a trusted hop says the client used https. Our own listener is plain http. */
export const CLIENT_PROTO_HEADER = 'x-briefroom-client-proto';

/** Which tunnel, if any, is forwarding requests to the app from loopback right now. */
export type LoopbackHop = () => 'tailscale' | 'funnel' | 'cloudflare' | null;

const LOOPBACK = new BlockList();
LOOPBACK.addSubnet('127.0.0.0', 8, 'ipv4');
LOOPBACK.addAddress('::1', 'ipv6');

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
 * value the client prepends to X-Forwarded-For never counts. Any incoming value of our own headers
 * is overwritten. Loopback is trusted only while a tunnel daemon runs, because cloudflared and
 * tailscale serve forward from there. Cloudflare's edge always overwrites CF-Connecting-IP, so it wins
 * behind cloudflared.
 */
export function createClientIpMiddleware(
  trustedProxies: readonly string[],
  loopbackHop: LoopbackHop = () => null,
) {
  const trusted = trustList(trustedProxies);
  const inList = (list: BlockList, address: string): boolean => {
    const family = isIP(address);
    return family !== 0 && list.check(address, family === 4 ? 'ipv4' : 'ipv6');
  };

  return (req: IncomingMessage, _res: ServerResponse, next: () => void): void => {
    const socket = normalize(req.socket.remoteAddress ?? '');
    const hop = loopbackHop();
    const isTrusted = (address: string): boolean =>
      inList(trusted, address) || (hop !== null && inList(LOOPBACK, address));
    const fromTrusted = isTrusted(socket);
    const edgeClient =
      hop === 'cloudflare' && inList(LOOPBACK, socket) ? cloudflareClient(req) : null;
    req.headers[CLIENT_IP_HEADER] = !fromTrusted
      ? socket
      : (edgeClient ?? forwardedClient(req, socket, isTrusted));
    req.headers[CLIENT_PROTO_HEADER] = fromTrusted ? forwardedProto(req) : 'http';
    next();
  };
}

const first = (v: string | string[] | undefined): string =>
  (Array.isArray(v) ? v.join(',') : (v ?? '')).trim();

function cloudflareClient(req: IncomingMessage): string | null {
  const ip = normalize(first(req.headers['cf-connecting-ip']));
  return isIP(ip) === 0 ? null : ip;
}

/** The hop nearest to us appends last, so the last value is the one the trusted proxy wrote. */
function forwardedProto(req: IncomingMessage): 'http' | 'https' {
  const last = first(req.headers['x-forwarded-proto']).split(',').pop()?.trim().toLowerCase();
  return last === 'https' ? 'https' : 'http';
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
