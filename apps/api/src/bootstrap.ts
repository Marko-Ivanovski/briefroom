import type { INestApplication } from '@nestjs/common';
import { clientIpMiddleware } from './auth/client-ip.middleware.ts';

export function configureApp(app: INestApplication): void {
  // Registered on the adapter before init, so it runs ahead of the Better Auth handler mounted in AuthModule.configure.
  app.use(clientIpMiddleware);
  app.setGlobalPrefix('api', { exclude: ['mcp', 'mcp/{*path}', '.well-known/{*path}'] });
  app.enableShutdownHooks();
}
