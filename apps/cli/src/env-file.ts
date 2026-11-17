import { randomBytes } from 'node:crypto';

/** Every variable in the root .env.example, in order. A test keeps the two lists equal. */
export const ENV_KEYS = [
  'DATABASE_URL',
  'BETTER_AUTH_SECRET',
  'BRIEFROOM_PUBLIC_URL',
  'BRIEFROOM_SECRET_KEY',
  'BRIEFROOM_DATA_DIR',
  'PORT',
  'BRIEFROOM_WEB_DIR',
  'HOST',
  'BRIEFROOM_TESTKIT',
  'VITE_BRIEFROOM_TESTKIT',
  'POSTGRES_PASSWORD',
  'BRIEFROOM_TRUSTED_PROXIES',
  'BRIEFROOM_BIND',
  'BRIEFROOM_VERSION',
  'BRIEFROOM_HOST',
  'BRIEFROOM_HTTPS_PORT',
  'COMPOSE_PROFILES',
] as const;

const LINE = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/;

function unquote(value: string): string {
  const v = value.trim();
  const quote = v[0];
  return v.length >= 2 && (quote === '"' || quote === "'") && v.endsWith(quote)
    ? v.slice(1, -1)
    : v;
}

export function parseEnv(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const match = LINE.exec(line);
    if (match?.[1] !== undefined) values[match[1]] = unquote(match[2] ?? '');
  }
  return values;
}

/**
 * Sets the given keys in an existing file and leaves every other line alone, so comments and keys
 * the user added survive. Known keys that are missing are appended empty. Values must be one line.
 */
export function mergeEnv(existing: string | null, set: Record<string, string>): string {
  const lines = existing === null ? [] : existing.replace(/\r?\n$/, '').split(/\r?\n/);
  const seen = new Set<string>();
  const merged = lines.map((line) => {
    const key = LINE.exec(line)?.[1];
    if (key === undefined) return line;
    seen.add(key);
    return key in set ? `${key}=${set[key]}` : line;
  });
  for (const key of new Set([...ENV_KEYS, ...Object.keys(set)])) {
    if (!seen.has(key)) merged.push(`${key}=${set[key] ?? ''}`);
  }
  return `${merged.join('\n')}\n`;
}

/** 32 random bytes as 43 base64url characters. */
export function generateSecret(): string {
  return randomBytes(32).toString('base64url');
}
