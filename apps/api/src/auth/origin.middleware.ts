import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Env } from '../config/env.ts';

const SAFE_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS']);
const CROSS_SITE: ReadonlySet<string> = new Set(['cross-site', 'same-site']);

/** The one list both Better Auth and our own mutation check trust. */
export function trustedOrigins(env: Env): string[] {
  return [new URL(env.publicUrl).origin];
}

/**
 * Cookie-authenticated routes of ours are only for the web app, so a browser request from another
 * origin is refused (CSRF). Requests with neither header come from the CLI or another server and
 * pass: they cannot carry the user's cookie. Better Auth checks its own /api/auth routes the same way.
 */
export function originCheckMiddleware(allowed: readonly string[]) {
  const trusted = new Set(allowed);
  return (req: IncomingMessage, res: ServerResponse, next: () => void): void => {
    const path = (req.url ?? '').split('?')[0]!;
    if (SAFE_METHODS.has(req.method ?? 'GET') || !path.startsWith('/api/')) return next();

    const origin = req.headers.origin;
    const site = req.headers['sec-fetch-site'];
    const badOrigin = origin !== undefined && !trusted.has(origin);
    const badSite = typeof site === 'string' && CROSS_SITE.has(site);
    if (!badOrigin && !badSite) return next();

    res.statusCode = 403;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ statusCode: 403, message: 'Cross-origin request refused' }));
  };
}
