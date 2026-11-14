import { authSchema, type Db } from '@briefroom/db';
import { apiKey } from '@better-auth/api-key';
import { drizzleAdapter } from '@better-auth/drizzle-adapter';
import { betterAuth } from 'better-auth';
import { APIError, createAuthMiddleware } from 'better-auth/api';
import { admin, organization } from 'better-auth/plugins';
import type { Env } from '../config/env.ts';
import { CLIENT_IP_HEADER } from './client-ip.middleware.ts';

export const API_KEY_PREFIX = 'brf_';

// Default-deny: Better Auth's own HTTP routes (organization, admin, api-key, ...) would bypass our
// access rules, so over HTTP only what the browser needs is open. Our controllers use the
// server API, which carries no HTTP request and is never refused here.
const ALLOWED_HTTP_PATHS: ReadonlySet<string> = new Set([
  '/sign-in/email',
  '/sign-out',
  '/get-session',
  '/ok',
  '/error',
]);

export function createAuth(db: Db, env: Env) {
  return betterAuth({
    secret: env.authSecret,
    baseURL: env.publicUrl,
    trustedOrigins: [env.publicUrl],
    database: drizzleAdapter(db, { provider: 'pg', schema: authSchema }),
    emailAndPassword: { enabled: true, disableSignUp: true },
    advanced: {
      useSecureCookies: new URL(env.publicUrl).protocol === 'https:',
      ipAddress: { ipAddressHeaders: [CLIENT_IP_HEADER] },
    },
    rateLimit: {
      enabled: true,
      customRules: { '/sign-in/email': { window: 60, max: 5 } },
    },
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        if (ctx.request && !ALLOWED_HTTP_PATHS.has(ctx.path)) {
          throw new APIError('FORBIDDEN', { message: 'This endpoint is not available' });
        }
      }),
    },
    plugins: [
      // The admin plugin exists only so the server can create users (public sign-up is off).
      // Its user-level `role` is never a workspace role: workspace roles live only in the
      // organization `member` table.
      admin(),
      // Only the server API creates workspaces. Task 2.2 replaces `false` with the install-owner check.
      organization({ allowUserToCreateOrganization: false }),
      apiKey({ defaultPrefix: API_KEY_PREFIX, enableMetadata: true }),
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;
