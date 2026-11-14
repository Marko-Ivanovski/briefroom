import { authSchema, type Db } from '@briefroom/db';
import { apiKey } from '@better-auth/api-key';
import { drizzleAdapter } from '@better-auth/drizzle-adapter';
import { betterAuth } from 'better-auth';
import { APIError, createAuthMiddleware } from 'better-auth/api';
import { admin, organization } from 'better-auth/plugins';
import type { Env } from '../config/env.ts';

export const API_KEY_PREFIX = 'brf_';

// Better Auth's own endpoints that would bypass our access rules. Our controllers call the
// server API instead, which carries no HTTP request, so only requests from outside are refused.
const BLOCKED_HTTP_PATHS: ReadonlySet<string> = new Set([
  '/organization/create',
  '/organization/invite-member',
  '/organization/accept-invitation',
  '/organization/remove-member',
  '/organization/update-member-role',
  '/organization/leave',
]);

export function createAuth(db: Db, env: Env) {
  return betterAuth({
    secret: env.authSecret,
    baseURL: env.publicUrl,
    trustedOrigins: [env.publicUrl],
    database: drizzleAdapter(db, { provider: 'pg', schema: authSchema }),
    emailAndPassword: { enabled: true, disableSignUp: true },
    advanced: { useSecureCookies: env.publicUrl.startsWith('https://') },
    rateLimit: {
      enabled: true,
      customRules: { '/sign-in/email': { window: 60, max: 5 } },
    },
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        if (ctx.request && BLOCKED_HTTP_PATHS.has(ctx.path)) {
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
