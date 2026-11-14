import type { INestApplication } from '@nestjs/common';
import { ENV, type Env } from './config/env.ts';
import { clientIpMiddleware } from './auth/client-ip.middleware.ts';
import { originCheckMiddleware, trustedOrigins } from './auth/origin.middleware.ts';
import { referrerPolicyMiddleware } from './auth/referrer-policy.middleware.ts';

export function configureApp(app: INestApplication): void {
  // Registered on the adapter before init, so it runs ahead of the Better Auth handler mounted in AuthModule.configure.
  app.use(clientIpMiddleware);
  app.use(referrerPolicyMiddleware);
  app.use(originCheckMiddleware(trustedOrigins(app.get<Env>(ENV))));
  app.setGlobalPrefix('api', { exclude: ['mcp', 'mcp/{*path}', '.well-known/{*path}'] });
  app.enableShutdownHooks();

  // Limits receiving a request (headers, then the whole body), not sending a response. A long-lived
  // response stream such as SSE is unaffected, but a long-lived request body would have to opt out.
  const server = app.getHttpServer();
  server.requestTimeout = 180_000;
  server.headersTimeout = 30_000;
}
