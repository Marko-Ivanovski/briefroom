import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it } from 'vitest';
import {
  CLIENT_IP_HEADER,
  CLIENT_PROTO_HEADER,
  createClientIpMiddleware,
} from '../src/auth/client-ip.middleware.ts';

function run(
  trusted: string[],
  socket: string | undefined,
  headers: Record<string, string> = {},
): string | string[] | undefined {
  const req = { headers: { ...headers }, socket: { remoteAddress: socket } } as IncomingMessage;
  let called = false;
  createClientIpMiddleware(trusted)(req, {} as ServerResponse, () => (called = true));
  expect(called).toBe(true);
  return req.headers[CLIENT_IP_HEADER];
}

describe('clientIpMiddleware', () => {
  it('uses the socket address when no proxy is trusted, whatever the headers say', () => {
    expect(run([], '203.0.113.9', { 'x-forwarded-for': '198.51.100.1' })).toBe('203.0.113.9');
  });

  it('ignores a spoofed X-Forwarded-For from an untrusted socket', () => {
    expect(
      run(['172.30.0.2'], '203.0.113.9', { 'x-forwarded-for': '10.0.0.1, 198.51.100.1' }),
    ).toBe('203.0.113.9');
  });

  it('always overwrites an incoming x-briefroom-client-ip', () => {
    expect(run([], '203.0.113.9', { [CLIENT_IP_HEADER]: '10.9.9.9' })).toBe('203.0.113.9');
    expect(
      run(['172.30.0.2'], '172.30.0.2', {
        [CLIENT_IP_HEADER]: '10.9.9.9',
        'x-forwarded-for': '198.51.100.1',
      }),
    ).toBe('198.51.100.1');
  });

  it('reads X-Forwarded-For from a trusted socket', () => {
    expect(run(['172.30.0.2'], '172.30.0.2', { 'x-forwarded-for': '198.51.100.1' })).toBe(
      '198.51.100.1',
    );
  });

  it('keeps the socket address when a trusted socket sends no X-Forwarded-For', () => {
    expect(run(['172.30.0.2'], '172.30.0.2')).toBe('172.30.0.2');
  });

  it('takes the rightmost untrusted address, so a client-prepended value cannot win', () => {
    expect(run(['172.30.0.2'], '172.30.0.2', { 'x-forwarded-for': '10.0.0.1, 198.51.100.1' })).toBe(
      '198.51.100.1',
    );
  });

  it('skips a chain of trusted hops, including CIDR ranges', () => {
    expect(
      run(['172.30.0.0/16', '10.1.2.3'], '172.30.0.2', {
        'x-forwarded-for': '198.51.100.1, 10.1.2.3, 172.30.5.5',
      }),
    ).toBe('198.51.100.1');
  });

  it('uses the leftmost address when every hop is trusted', () => {
    expect(
      run(['172.30.0.0/16'], '172.30.0.2', { 'x-forwarded-for': '172.30.9.9, 172.30.1.1' }),
    ).toBe('172.30.9.9');
  });

  it('matches an IPv4-mapped IPv6 socket address against an IPv4 entry', () => {
    expect(run(['172.30.0.2'], '::ffff:172.30.0.2', { 'x-forwarded-for': '198.51.100.1' })).toBe(
      '198.51.100.1',
    );
  });

  it('reports an untrusted IPv4-mapped socket as plain IPv4', () => {
    expect(run(['172.30.0.2'], '::ffff:203.0.113.9', { 'x-forwarded-for': '10.0.0.1' })).toBe(
      '203.0.113.9',
    );
  });

  it('normalizes IPv4-mapped addresses inside X-Forwarded-For', () => {
    expect(run(['172.30.0.2'], '172.30.0.2', { 'x-forwarded-for': '::ffff:198.51.100.1' })).toBe(
      '198.51.100.1',
    );
  });

  it('trusts IPv6 proxies by address and by range', () => {
    expect(run(['fd00::/8'], 'fd00::5', { 'x-forwarded-for': '2001:db8::1' })).toBe('2001:db8::1');
  });

  it('falls back to the socket address when the forwarded value is not an address', () => {
    expect(run(['172.30.0.2'], '172.30.0.2', { 'x-forwarded-for': 'not-an-ip' })).toBe(
      '172.30.0.2',
    );
  });

  it('sets an empty value when the socket has no address', () => {
    expect(run([], undefined)).toBe('');
  });
});

describe('clientIpMiddleware with a tunnel (R185)', () => {
  type Mode = 'tailscale' | 'funnel' | 'cloudflare' | null;

  function runWith(
    mode: Mode,
    via: 'tunnel-socket' | string,
    headers: Record<string, string> = {},
    trusted: string[] = [],
  ) {
    const onSocket = via === 'tunnel-socket';
    const req = {
      headers: { ...headers },
      socket: { remoteAddress: onSocket ? undefined : via },
    } as IncomingMessage;
    createClientIpMiddleware(trusted, { cameThrough: () => onSocket, mode: () => mode })(
      req,
      {} as ServerResponse,
      () => undefined,
    );
    return { ip: req.headers[CLIENT_IP_HEADER], proto: req.headers[CLIENT_PROTO_HEADER] };
  }

  const SPOOF = { 'x-forwarded-for': '198.51.100.1', 'x-forwarded-proto': 'https' };

  it.each(['tailscale', 'funnel', 'cloudflare', null] as const)(
    'ignores spoofed headers on loopback TCP while %s runs',
    (mode) => {
      for (const socket of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
        expect(runWith(mode, socket, { ...SPOOF, 'cf-connecting-ip': '203.0.113.77' })).toEqual({
          ip: socket === '::1' ? '::1' : '127.0.0.1',
          proto: 'http',
        });
      }
    },
  );

  it('honours X-Forwarded-For and X-Forwarded-Proto on the tunnel socket', () => {
    expect(runWith('tailscale', 'tunnel-socket', SPOOF)).toEqual({
      ip: '198.51.100.1',
      proto: 'https',
    });
  });

  it('keeps the rightmost address on the socket, so a prepended value cannot win', () => {
    expect(
      runWith('funnel', 'tunnel-socket', { 'x-forwarded-for': '10.0.0.1, 203.0.113.5' }).ip,
    ).toBe('203.0.113.5');
  });

  it('falls back to loopback when the tunnel sent no address', () => {
    expect(runWith('tailscale', 'tunnel-socket')).toEqual({ ip: '127.0.0.1', proto: 'http' });
  });

  it('prefers CF-Connecting-IP on the socket only behind cloudflared', () => {
    const headers = { 'cf-connecting-ip': '203.0.113.77', 'x-forwarded-for': '198.51.100.1' };
    expect(runWith('cloudflare', 'tunnel-socket', headers).ip).toBe('203.0.113.77');
    expect(runWith('funnel', 'tunnel-socket', headers).ip).toBe('198.51.100.1');
    expect(
      runWith('cloudflare', 'tunnel-socket', { ...headers, 'cf-connecting-ip': 'garbage' }).ip,
    ).toBe('198.51.100.1');
  });

  it('ignores X-Forwarded-Proto https from an untrusted non-loopback socket (Minor 8)', () => {
    expect(runWith('cloudflare', '203.0.113.9', SPOOF)).toEqual({
      ip: '203.0.113.9',
      proto: 'http',
    });
  });

  it('still believes a configured proxy such as Caddy over TCP', () => {
    expect(runWith('tailscale', '198.51.100.2', SPOOF, ['198.51.100.2'])).toEqual({
      ip: '198.51.100.1',
      proto: 'https',
    });
  });

  it('reads the protocol the nearest hop wrote', () => {
    const proto = (value: string) =>
      runWith('tailscale', 'tunnel-socket', { 'x-forwarded-proto': value }).proto;
    expect(proto('http, https')).toBe('https');
    expect(proto('https, http')).toBe('http');
  });
});
