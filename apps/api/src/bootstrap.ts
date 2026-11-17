import type { INestApplication } from '@nestjs/common';
import { ENV, type Env } from './config/env.ts';
import { createClientIpMiddleware } from './auth/client-ip.middleware.ts';
import { bodyLimitMiddleware } from './auth/body-limit.middleware.ts';
import { originCheckMiddleware } from './auth/origin.middleware.ts';
import { referrerPolicyMiddleware } from './auth/referrer-policy.middleware.ts';
import { secureCookieMiddleware } from './auth/secure-cookie.middleware.ts';
import { TunnelState } from './remote-access/tunnel-state.ts';

export function configureApp(app: INestApplication): void {
  const env = app.get<Env>(ENV);
  // Registered on the adapter before init, so it runs ahead of the Better Auth handler mounted in AuthModule.configure.
  const tunnel = app.get(TunnelState);
  app.use(createClientIpMiddleware(env.trustedProxies, () => tunnel.forwardingMode()));
  app.use(secureCookieMiddleware);
  app.use(bodyLimitMiddleware);
  app.use(referrerPolicyMiddleware);
  app.use(originCheckMiddleware(() => tunnel.origins()));
  app.setGlobalPrefix('api', { exclude: ['mcp', 'mcp/{*path}', '.well-known/{*path}'] });
  app.enableShutdownHooks();

  // Limits receiving a request (headers, then the whole body), not sending a response. A long-lived
  // response stream such as SSE is unaffected, but a long-lived request body would have to opt out.
  const server = app.getHttpServer();
  server.requestTimeout = 180_000;
  server.headersTimeout = 30_000;
}
