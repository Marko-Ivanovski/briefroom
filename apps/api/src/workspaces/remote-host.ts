import { lookup as dnsLookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { VersionResponse } from '@briefroom/contracts';
import { BadGatewayException, BadRequestException } from '@nestjs/common';
import { Agent } from 'undici';
import { z } from 'zod';

export interface ParsedInvite {
  base: string;
  token: string;
}

export interface RemoteInvite {
  installId: string;
  workspaceId: string;
  workspaceName: string;
}

const MAX_URL_LENGTH = 2048;
const MAX_BODY_BYTES = 64 * 1024;
const TIMEOUT_MS = 5000;
const JOIN_SEGMENT = '/join/';
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{16,128}$/;

const RemoteVersion = VersionResponse.extend({ installId: z.string().min(1).max(64) });
const RemoteLookup = z.object({
  valid: z.literal(true),
  workspaceId: z.string().min(1).max(64),
  workspaceName: z.string().max(200),
});

const invalidUrl = () =>
  new BadRequestException({
    code: 'invalid_invite_url',
    message: 'That is not a Briefroom invite link.',
  });
const unreachable = () =>
  new BadGatewayException({
    code: 'host_unreachable',
    message: 'The other install did not answer. Check the link and try again.',
  });
const inviteInvalid = () =>
  new BadRequestException({
    code: 'invite_invalid',
    message: 'This invite link no longer works.',
  });

// Loopback, RFC1918 and ULA are absent on purpose: installs on this computer or LAN are the core case.
const NOT_A_HOST = new BlockList();
NOT_A_HOST.addSubnet('169.254.0.0', 16, 'ipv4');
NOT_A_HOST.addSubnet('0.0.0.0', 8, 'ipv4');
NOT_A_HOST.addSubnet('224.0.0.0', 4, 'ipv4');
NOT_A_HOST.addAddress('255.255.255.255', 'ipv4');
NOT_A_HOST.addSubnet('fe80::', 10, 'ipv6');
NOT_A_HOST.addAddress('::', 'ipv6');
NOT_A_HOST.addSubnet('ff00::', 8, 'ipv6');
NOT_A_HOST.addAddress('fd00:ec2::254', 'ipv6');

const MAPPED_V4 = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i;
const MAPPED_HEX = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i;

/** True for link-local (cloud metadata), unspecified and multicast addresses, including IPv4-mapped IPv6 forms. */
export function isBlockedAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return NOT_A_HOST.check(address, 'ipv4');
  if (family !== 6) return true;
  const dotted = MAPPED_V4.exec(address)?.[1];
  if (dotted) return NOT_A_HOST.check(dotted, 'ipv4');
  const hex = MAPPED_HEX.exec(address);
  if (hex) {
    const hi = parseInt(hex[1]!, 16);
    const lo = parseInt(hex[2]!, 16);
    return NOT_A_HOST.check(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`, 'ipv4');
  }
  return NOT_A_HOST.check(address, 'ipv6');
}

export function parseInviteUrl(input: string): ParsedInvite {
  if (input.length > MAX_URL_LENGTH) throw invalidUrl();
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw invalidUrl();
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw invalidUrl();
  if (url.username || url.password) throw invalidUrl();
  const path = url.pathname.replace(/\/+$/, '');
  const at = path.lastIndexOf(JOIN_SEGMENT);
  if (at === -1) throw invalidUrl();
  const token = path.slice(at + JOIN_SEGMENT.length);
  if (!TOKEN_SHAPE.test(token)) throw invalidUrl();
  return { base: url.origin + path.slice(0, at), token };
}

export function joinUrlOf({ base, token }: ParsedInvite): string {
  return `${base}${JOIN_SEGMENT}${token}`;
}

async function readCapped(res: Response): Promise<string> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel();
      throw new Error('body too large');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

interface Answer {
  status: number;
  body: string;
}

function within<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error('timeout'));
    if (signal.aborted) return onAbort();
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

/** Resolves the host once and refuses it if any address is not a plain host. The caller connects to the vetted address only. */
async function vetAddress(
  base: string,
  signal: AbortSignal,
): Promise<{ address: string; family: number }> {
  const hostname = new URL(base).hostname.replace(/^\[|\]$/g, '');
  const resolved = await within(dnsLookup(hostname, { all: true, verbatim: true }), signal);
  const first = resolved[0];
  if (!first || resolved.some((r) => isBlockedAddress(r.address))) throw unreachable();
  return first;
}

// Only accept and a fixed path go out: no cookies, auth or forwarded headers reach another install.
async function get(url: string, signal: AbortSignal, dispatcher: Agent): Promise<Answer> {
  try {
    const res = await fetch(url, {
      method: 'GET',
      redirect: 'error',
      signal,
      headers: { accept: 'application/json' },
      dispatcher,
    } as RequestInit);
    return { status: res.status, body: await readCapped(res) };
  } catch {
    throw unreachable();
  }
}

function jsonOf(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

const ok = (status: number) => status >= 200 && status <= 299;

/**
 * One 5 s budget covers resolving and both requests. The version call goes first so that only a
 * Briefroom install is ever asked about the token.
 */
export async function fetchRemoteInvite({ base, token }: ParsedInvite): Promise<RemoteInvite> {
  const signal = AbortSignal.timeout(TIMEOUT_MS);
  let pinned: { address: string; family: number };
  try {
    pinned = await vetAddress(base, signal);
  } catch {
    throw unreachable();
  }
  // The agent connects to the vetted address, so a second DNS answer cannot redirect it. Host and SNI keep the hostname.
  const dispatcher = new Agent({
    connect: {
      lookup: (_host, options, callback) => {
        if ((options as { all?: boolean }).all) callback(null, [pinned] as never);
        else callback(null, pinned.address, pinned.family);
      },
    },
  });
  try {
    const version = await get(`${base}/api/version`, signal, dispatcher);
    const parsedVersion = ok(version.status)
      ? RemoteVersion.safeParse(jsonOf(version.body))
      : undefined;
    if (!parsedVersion?.success) throw unreachable();

    const lookup = await get(`${base}/api/v1/join/${token}`, signal, dispatcher);
    if (lookup.status === 404) throw inviteInvalid();
    if (!ok(lookup.status)) throw unreachable();
    const raw = jsonOf(lookup.body);
    if ((raw as { valid?: unknown } | null)?.valid === false) throw inviteInvalid();
    const found = RemoteLookup.safeParse(raw);
    if (!found.success) throw unreachable();

    return {
      installId: parsedVersion.data.installId,
      workspaceId: found.data.workspaceId,
      workspaceName: found.data.workspaceName,
    };
  } finally {
    await dispatcher.destroy().catch(() => undefined);
  }
}
