import { BlockList, isIP } from 'node:net';
import type { IncomingMessage, ServerResponse } from 'node:http';

export const CLIENT_IP_HEADER = 'x-briefroom-client-ip';
/** `https` only when a trusted hop says the client used https. Our own listener is plain http. */
export const CLIENT_PROTO_HEADER = 'x-briefroom-client-proto';

/** How the middleware learns that a request came in on the tunnel socket, and from which tunnel. */
export interface TunnelHop {
  cameThrough(req: IncomingMessage): boolean;
  mode(): 'tailscale' | 'funnel' | 'cloudflare' | null;
}

const NO_TUNNEL: TunnelHop = { cameThrough: () => false, mode: () => null };

// A tunnel request carries no peer address of its own, so a missing header falls back to this.
const TUNNEL_FALLBACK_ADDRESS = '127.0.0.1';

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
  // A range written as IPv4-mapped IPv6 would need its prefix rebased onto IPv4, so it is refused.
  if (MAPPED_V4.test(address)) return false;
  return /^\d{1,3}$/.test(prefix) && Number(prefix) <= (family === 4 ? 32 : 128);
}

function trustList(entries: readonly string[]): BlockList {
  const list = new BlockList();
  for (const entry of entries) {
    const [rawAddress = '', prefix] = entry.split('/');
    // The family is taken after normalizing, because a mapped address is stored as plain IPv4.
    const address = normalize(rawAddress);
    const family = isIP(address) === 4 ? 'ipv4' : 'ipv6';
    if (prefix === undefined) list.addAddress(address, family);
    else list.addSubnet(address, Number(prefix), family);
  }
  return list;
}

/**
 * Sets the client address that rate limits and audit rows key on. Forwarded headers are believed
 * only from a configured proxy's socket or from the tunnel socket, and the rightmost address that is
 * not itself trusted wins, so a value the client prepends to X-Forwarded-For never counts. Any
 * incoming value of our own headers is overwritten. Loopback TCP is never trusted: in userspace
 * mode tailscaled forwards every tailnet connection to <tailnet IP>:N on to localhost:N (R185).
 * Cloudflare's edge always overwrites CF-Connecting-IP, so it wins behind cloudflared, and only there.
 */
export function createClientIpMiddleware(
  trustedProxies: readonly string[],
  tunnel: TunnelHop = NO_TUNNEL,
) {
  const trusted = trustList(trustedProxies);
  const isTrusted = (address: string): boolean => {
    const family = isIP(address);
    return family !== 0 && trusted.check(address, family === 4 ? 'ipv4' : 'ipv6');
  };

  return (req: IncomingMessage, _res: ServerResponse, next: () => void): void => {
    const viaTunnel = tunnel.cameThrough(req);
    const socket = viaTunnel ? TUNNEL_FALLBACK_ADDRESS : normalize(req.socket.remoteAddress ?? '');
    const fromTrusted = viaTunnel || isTrusted(socket);
    const edgeClient = viaTunnel && tunnel.mode() === 'cloudflare' ? cloudflareClient(req) : null;
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
