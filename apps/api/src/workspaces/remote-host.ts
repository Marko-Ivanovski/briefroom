import { JoinLookup, VersionResponse } from '@briefroom/contracts';
import { BadGatewayException, BadRequestException } from '@nestjs/common';
import type { z } from 'zod';

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
  if (!token || token.includes('/')) throw invalidUrl();
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

// Only accept and a fixed path go out: no cookies, auth or forwarded headers reach another install.
async function get(url: string, signal: AbortSignal): Promise<Answer> {
  try {
    const res = await fetch(url, {
      method: 'GET',
      redirect: 'error',
      signal,
      headers: { accept: 'application/json' },
    });
    return { status: res.status, body: await readCapped(res) };
  } catch {
    throw unreachable();
  }
}

function parseJson<T>(schema: z.ZodType<T>, body: string): T | undefined {
  try {
    const parsed = schema.safeParse(JSON.parse(body));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Loopback and private-range hosts are allowed on purpose: installs on this computer or LAN are
 * the core case, so there is no DNS or IP blocking here. One 5 s budget covers both requests.
 */
export async function fetchRemoteInvite({ base, token }: ParsedInvite): Promise<RemoteInvite> {
  const signal = AbortSignal.timeout(TIMEOUT_MS);

  const lookup = await get(`${base}/api/v1/join/${token}`, signal);
  if (lookup.status === 404) throw inviteInvalid();
  if (lookup.status < 200 || lookup.status > 299) throw unreachable();
  const found = parseJson(JoinLookup, lookup.body);
  if (!found?.valid) throw inviteInvalid();

  const version = await get(`${base}/api/version`, signal);
  if (version.status < 200 || version.status > 299) throw unreachable();
  const installId = parseJson(VersionResponse, version.body)?.installId;
  if (!installId) throw unreachable();

  return { installId, workspaceId: found.workspaceId, workspaceName: found.workspaceName };
}
