import { Global, Module } from '@nestjs/common';
import { APP_GUARD, Reflector } from '@nestjs/core';
import { AuthGuard, AuthService } from '@thallesp/nestjs-better-auth';
import { AccessService } from './access.service.ts';
import { RequestGuard } from './request.guard.ts';
import { WorkspaceScopeGuard } from './workspace-scope.guard.ts';

@Global()
@Module({
  providers: [
    AccessService,
    {
      provide: AuthGuard,
      useFactory: (reflector: Reflector, auth: AuthService) =>
        new AuthGuard(reflector, { auth: auth.instance }),
      inject: [Reflector, AuthService],
    },
    WorkspaceScopeGuard,
    { provide: APP_GUARD, useClass: RequestGuard },
  ],
  exports: [AccessService],
})
export class AccessModule {}
