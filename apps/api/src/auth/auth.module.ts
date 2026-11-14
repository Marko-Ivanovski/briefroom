import { type Db } from '@briefroom/db';
import { Global, Logger, Module } from '@nestjs/common';
import { AuthModule as BetterAuthModule } from '@thallesp/nestjs-better-auth';
import { ENV, type Env } from '../config/env.ts';
import { DB } from '../database/database.module.ts';
import { createAuth, type Auth } from './auth.ts';

export const AUTH = Symbol('AUTH');

@Global()
@Module({
  providers: [
    {
      provide: AUTH,
      useFactory: (db: Db, env: Env): Auth => {
        if (env.usingDevAuthSecret) {
          new Logger('Auth').warn(
            'BETTER_AUTH_SECRET is not set: using the dev-only secret. Set it before exposing this install.',
          );
        }
        return createAuth(db, env);
      },
      inject: [DB, ENV],
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
      useFactory: (auth: Auth) => ({ auth }),
    }),
  ],
})
export class AuthModule {}
