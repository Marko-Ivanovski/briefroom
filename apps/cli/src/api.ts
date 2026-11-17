import type { Context } from './context.ts';
import { CliError } from './errors.ts';

/** The API major this CLI speaks. A different major on the install means the CLI is out of date. */
export const CLI_API_MAJOR = 1;

const REQUEST_TIMEOUT_MS = 15_000;

// Cleartext is only acceptable where the traffic never leaves this machine.
function isLoopback(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname === '[::1]' ||
    /^127(\.\d{1,3}){3}$/.test(hostname)
  );
}

function assertSecure(url: URL): void {
  if (url.protocol === 'http:' && !isLoopback(url.hostname)) {
    throw new CliError(
      `${url.origin} uses plain http, which would send your token unencrypted. Use https://${url.host}.`,
    );
  }
}

export function normaliseAddress(address: string): string {
  const trimmed = address.trim();
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new CliError(`"${address}" is not a valid address.`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new CliError('The address must start with https://.');
  }
  assertSecure(url);
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

export async function request(
  ctx: Context,
  baseUrl: string,
  path: string,
  init: { method?: string; body?: unknown; token?: string } = {},
): Promise<Response> {
  assertSecure(new URL(baseUrl));
  try {
    return await ctx.fetch(`${baseUrl}${path}`, {
      method: init.method ?? 'GET',
      headers: {
        ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(init.token === undefined ? {} : { authorization: `Bearer ${init.token}` }),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new CliError(`Could not reach a Briefroom install at ${baseUrl}.`);
  }
}

/** Run before every command that talks to an install. Exits with code 2 when the API major differs. */
export async function assertCompatible(ctx: Context, baseUrl: string): Promise<string | null> {
  const res = await request(ctx, baseUrl, '/api/version');
  const body: unknown = res.ok ? await res.json().catch(() => null) : null;
  const api = (body as { api?: unknown } | null)?.api;
  const installId = (body as { installId?: unknown } | null)?.installId;
  const major = typeof api === 'string' ? Number.parseInt(api, 10) : Number.NaN;
  if (Number.isNaN(major)) throw new CliError(`${baseUrl} does not look like a Briefroom install.`);
  if (major !== CLI_API_MAJOR) {
    throw new CliError(
      `This Briefroom install runs API v${major}. Update the CLI with npm i -g briefroom.`,
      2,
    );
  }
  return typeof installId === 'string' && installId !== '' ? installId : null;
}
