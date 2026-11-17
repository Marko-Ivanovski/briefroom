import { DEV_DATABASE_URL } from '@briefroom/db';
import { existsSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { isProxyEntry } from '../auth/client-ip.middleware.ts';

const DEFAULT_WEB_DIR = fileURLToPath(new URL('../../../web/dist', import.meta.url));
const DEV_PUBLIC_URL = 'http://localhost:5173';
export const DEV_AUTH_SECRET = 'briefroom-dev-only-secret-never-use-in-production';
export const DEV_SECRET_KEY = 'briefroom-dev-only-secret-key-never-use-in-production';

const PublicUrl = z
  .url()
  .refine((u) => /^https?:\/\//i.test(u), 'must be an http or https url')
  .transform((u) => u.replace(/\/+$/, ''));

const Port = z.coerce.number().int().min(1).max(65535);

/** The folder that holds pnpm-workspace.yaml, found from the working directory so bundling cannot move it. */
function findRepoRoot(from: string): string | undefined {
  for (let dir = resolve(from); ; dir = dirname(dir)) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir;
    if (dirname(dir) === dir) return undefined;
  }
}

const TrustedProxies = z
  .string()
  .default('')
  .transform((v) => v.split(',').map((entry) => entry.trim()))
  .transform((entries) => (entries.length === 1 && entries[0] === '' ? [] : entries))
  .refine(
    (entries) => entries.every(isProxyEntry),
    'must be a comma list of IP addresses or CIDR ranges',
  );

const DataDir = z
  .string()
  .min(1)
  .refine((v) => isAbsolute(v), 'must be an absolute path');

function schemaFor(production: boolean, defaultDataDir: string | undefined) {
  return z.object({
    DATABASE_URL: production ? z.string().min(1) : z.string().min(1).default(DEV_DATABASE_URL),
    BRIEFROOM_PUBLIC_URL: production ? PublicUrl : PublicUrl.default(DEV_PUBLIC_URL),
    BETTER_AUTH_SECRET: production
      ? z
          .string()
          .min(32, 'must be at least 32 characters')
          .refine((v) => v !== DEV_AUTH_SECRET, 'must not be the dev-only secret')
      : z.string().min(1).default(DEV_AUTH_SECRET),
    BRIEFROOM_SECRET_KEY: production
      ? z
          .string()
          .min(32, 'must be at least 32 characters')
          .refine((v) => v !== DEV_SECRET_KEY, 'must not be the dev-only key')
      : z.string().min(1).default(DEV_SECRET_KEY),
    PORT: Port.default(4300),
    HOST: z.string().min(1).default('127.0.0.1'),
    BRIEFROOM_BIND: z.string().min(1).default('127.0.0.1'),
    BRIEFROOM_WEB_DIR: z.string().min(1).default(DEFAULT_WEB_DIR),
    BRIEFROOM_DATA_DIR:
      production || defaultDataDir === undefined ? DataDir : DataDir.default(defaultDataDir),
    BRIEFROOM_TRUSTED_PROXIES: TrustedProxies,
    BRIEFROOM_TESTKIT: z
      .string()
      .optional()
      .refine(
        (v) => !production || v !== '1',
        'is for tests only and must not be set in production',
      ),
  });
}

export interface Env {
  databaseUrl: string;
  publicUrl: string;
  authSecret: string;
  usingDevAuthSecret: boolean;
  /** Seals stored credentials such as a tunnel token. Never used raw: secret-box derives the key. */
  secretKey: string;
  port: number;
  host: string;
  /** Host interface the compose file publishes the app port on. The app cannot see this itself. */
  bind: string;
  webDir: string;
  /** Addresses and CIDR ranges of reverse proxies whose X-Forwarded-For is believed. */
  trustedProxies: string[];
  /** Absolute path of the folder that holds uploaded files. */
  dataDir: string;
}

export const ENV = Symbol('ENV');

export function loadEnv(
  raw: Record<string, string | undefined> = process.env,
  cwd: string = process.cwd(),
): Env {
  const source = Object.fromEntries(Object.entries(raw).filter(([, value]) => value !== ''));
  const production = source.NODE_ENV === 'production';
  const root = production ? undefined : findRepoRoot(cwd);
  if (!production && source.BRIEFROOM_DATA_DIR === undefined && root === undefined) {
    throw new Error(
      'Invalid environment: BRIEFROOM_DATA_DIR is required (no repo root with pnpm-workspace.yaml found above the working directory to default it from)',
    );
  }
  const result = schemaFor(production, root && join(root, '.data')).safeParse(source);
  if (!result.success) {
    const problems = result.error.issues.map((i) => {
      const name = String(i.path[0]);
      return source[name] === undefined ? `${name} is required` : `${name}: ${i.message}`;
    });
    throw new Error(`Invalid environment: ${problems.join('; ')}`);
  }
  const v = result.data;
  return {
    databaseUrl: v.DATABASE_URL,
    publicUrl: v.BRIEFROOM_PUBLIC_URL,
    authSecret: v.BETTER_AUTH_SECRET,
    usingDevAuthSecret: v.BETTER_AUTH_SECRET === DEV_AUTH_SECRET,
    secretKey: v.BRIEFROOM_SECRET_KEY,
    port: v.PORT,
    host: v.HOST,
    bind: v.BRIEFROOM_BIND,
    webDir: v.BRIEFROOM_WEB_DIR,
    trustedProxies: v.BRIEFROOM_TRUSTED_PROXIES,
    dataDir: resolve(v.BRIEFROOM_DATA_DIR),
  };
}
