import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const DEFAULT_WEB_DIR = fileURLToPath(new URL('../../../web/dist', import.meta.url));

const EnvSchema = z.object({
  DATABASE_URL: z.string().min(1),
  BRIEFROOM_PUBLIC_URL: z.url(),
  PORT: z.coerce.number().int().positive().default(4300),
  BRIEFROOM_WEB_DIR: z.string().min(1).default(DEFAULT_WEB_DIR),
});

export interface Env {
  databaseUrl: string;
  publicUrl: string;
  port: number;
  webDir: string;
}

export const ENV = Symbol('ENV');

export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  const result = EnvSchema.safeParse(source);
  if (!result.success) {
    const problems = result.error.issues.map((i) => {
      const name = String(i.path[0]);
      return source[name] === undefined || source[name] === ''
        ? `${name} is required`
        : `${name}: ${i.message}`;
    });
    throw new Error(`Invalid environment: ${problems.join('; ')}`);
  }
  const v = result.data;
  return {
    databaseUrl: v.DATABASE_URL,
    publicUrl: v.BRIEFROOM_PUBLIC_URL,
    port: v.PORT,
    webDir: v.BRIEFROOM_WEB_DIR,
  };
}
