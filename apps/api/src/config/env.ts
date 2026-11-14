import { DEV_DATABASE_URL } from '@briefroom/db';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const DEFAULT_WEB_DIR = fileURLToPath(new URL('../../../web/dist', import.meta.url));
const DEV_PUBLIC_URL = 'http://localhost:5173';
export const DEV_AUTH_SECRET = 'briefroom-dev-only-secret-never-use-in-production';

const PublicUrl = z
  .url()
  .refine((u) => /^https?:\/\//i.test(u), 'must be an http or https url')
  .transform((u) => u.replace(/\/+$/, ''));

const Port = z.coerce.number().int().min(1).max(65535);

function schemaFor(production: boolean) {
  return z.object({
    DATABASE_URL: production ? z.string().min(1) : z.string().min(1).default(DEV_DATABASE_URL),
    BRIEFROOM_PUBLIC_URL: production ? PublicUrl : PublicUrl.default(DEV_PUBLIC_URL),
    BETTER_AUTH_SECRET: production
      ? z
          .string()
          .min(32, 'must be at least 32 characters')
          .refine((v) => v !== DEV_AUTH_SECRET, 'must not be the dev-only secret')
      : z.string().min(1).default(DEV_AUTH_SECRET),
    PORT: Port.default(4300),
    HOST: z.string().min(1).default('127.0.0.1'),
    BRIEFROOM_WEB_DIR: z.string().min(1).default(DEFAULT_WEB_DIR),
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
  port: number;
  host: string;
  webDir: string;
}

export const ENV = Symbol('ENV');

export function loadEnv(raw: Record<string, string | undefined> = process.env): Env {
  const source = Object.fromEntries(Object.entries(raw).filter(([, value]) => value !== ''));
  const result = schemaFor(source.NODE_ENV === 'production').safeParse(source);
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
    port: v.PORT,
    host: v.HOST,
    webDir: v.BRIEFROOM_WEB_DIR,
  };
}
