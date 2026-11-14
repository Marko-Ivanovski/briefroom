import { authSchema, type Db } from '@briefroom/db';
import { apiKey } from '@better-auth/api-key';
import { drizzleAdapter } from '@better-auth/drizzle-adapter';
import { Logger } from '@nestjs/common';
import { betterAuth } from 'better-auth';
import { APIError, createAuthMiddleware, isAPIError } from 'better-auth/api';
import { admin, organization } from 'better-auth/plugins';
import type { Env } from '../config/env.ts';
import { describeError } from '../errors/safe-error.ts';
import { CLIENT_IP_HEADER } from './client-ip.middleware.ts';
import { trustedOrigins } from './origin.middleware.ts';

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

const ENDPOINT_UNAVAILABLE = 'This endpoint is not available';
const OWNER_ONLY = 'Only the install owner can create workspaces';

/** Better Auth messages written by this app, safe to show. Any other APIError message is replaced by a generic one. */
export const SAFE_AUTH_MESSAGES: ReadonlySet<string> = new Set([ENDPOINT_UNAVAILABLE, OWNER_ONLY]);

export type CanCreateWorkspace = (userId: string) => Promise<boolean>;

export function createAuth(db: Db, env: Env, canCreateWorkspace: CanCreateWorkspace) {
  const log = new Logger('BetterAuth');
  return betterAuth({
    secret: env.authSecret,
    baseURL: env.publicUrl,
    trustedOrigins: trustedOrigins(env),
    database: drizzleAdapter(db, { provider: 'pg', schema: authSchema }),
    // Better Auth passes the caught error as an extra argument, and a failed query carries its SQL
    // parameters (emails, hashes, tokens). Only the level and the message are forwarded.
    logger: {
      log: (level, message) => {
        if (level === 'error') log.error(message);
        else if (level === 'warn') log.warn(message);
        else if (level === 'debug') log.debug(message);
        else log.log(message);
      },
    },
    onAPIError: {
      onError: (error) => {
        if (isAPIError(error) && error.statusCode < 500) return;
        log.error(`API error: ${describeError(error)}`);
      },
    },
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
          throw new APIError('FORBIDDEN', { message: ENDPOINT_UNAVAILABLE });
        }
      }),
    },
    plugins: [
      // The admin plugin exists only so the server can create users (public sign-up is off).
      // Its user-level `role` is never a workspace role: workspace roles live only in the
      // organization `member` table.
      admin(),
      // Better Auth skips allowUserToCreateOrganization for server calls that pass a userId, so the
      // beforeCreateOrganization hook is what stops a non-owner there. The option still guards HTTP.
      organization({
        allowUserToCreateOrganization: (user) => canCreateWorkspace(user.id),
        organizationHooks: {
          beforeCreateOrganization: async ({ user }) => {
            if (!(await canCreateWorkspace(user.id))) {
              throw new APIError('FORBIDDEN', {
                message: OWNER_ONLY,
              });
            }
          },
        },
      }),
      apiKey({ defaultPrefix: API_KEY_PREFIX, enableMetadata: true }),
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;
