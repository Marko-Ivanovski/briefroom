import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AuthGuard } from '@thallesp/nestjs-better-auth';
import { AccessService } from './access.service.ts';
import { RequestGuard } from './request.guard.ts';
import { WorkspaceScopeGuard } from './workspace-scope.guard.ts';

@Global()
@Module({
  providers: [
    AccessService,
    AuthGuard,
    WorkspaceScopeGuard,
    { provide: APP_GUARD, useClass: RequestGuard },
  ],
  exports: [AccessService],
})
export class AccessModule {}
