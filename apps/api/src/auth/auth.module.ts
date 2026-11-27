import { type Db } from '@briefroom/db';
import { Global, Logger, Module } from '@nestjs/common';
import { AuthModule as BetterAuthModule } from '@thallesp/nestjs-better-auth';
import { ENV, type Env } from '../config/env.ts';
import { DB } from '../database/database.module.ts';
import { RevocationModule } from '../members/revocation.module.ts';
import { RevocationService } from '../members/revocation.service.ts';
import { InstallService } from '../install/install.service.ts';
import { TunnelState } from '../remote-access/tunnel-state.ts';
import { JSON_BODY_LIMIT } from './body-limit.middleware.ts';
import { createAuth, type Auth } from './auth.ts';

export const AUTH = Symbol('AUTH');

@Global()
@Module({
  imports: [RevocationModule],
  providers: [
    {
      provide: AUTH,
      useFactory: (
        db: Db,
        env: Env,
        installs: InstallService,
        revocation: RevocationService,
        tunnel: TunnelState,
      ): Auth => {
        if (env.usingDevAuthSecret) {
          new Logger('Auth').warn(
            'BETTER_AUTH_SECRET is not set: using the dev-only secret. Set it before exposing this install.',
          );
        }
        return createAuth(
          db,
          env,
          (userId) => installs.canCreateWorkspace(userId),
          (userId) => revocation.sessionsRevoked(userId),
          () => tunnel.origins(),
        );
      },
      inject: [DB, ENV, InstallService, RevocationService, TunnelState],
    },
  ],
  exports: [AUTH],
})
class AuthCoreModule {}

@Module({
  imports: [
    AuthCoreModule,
    BetterAuthModule.forRootAsync({
      imports: [AuthCoreModule],
      inject: [AUTH],
      // RequestGuard (AccessModule) runs the package's AuthGuard itself, in a fixed order.
      disableGlobalAuthGuard: true,
      // Our API is JSON only, so form bodies are left unparsed on non-auth routes.
      useFactory: (auth: Auth) => ({
        auth,
        bodyParser: { json: { limit: JSON_BODY_LIMIT }, urlencoded: { enabled: false } },
        // The package refuses function-form trustedOrigins unless its CORS is off. The web app is
        // same-origin (served by the API, or through the Vite proxy in dev), so it needs no CORS.
        disableTrustedOriginsCors: true,
      }),
    }),
  ],
})
export class AuthModule {}
