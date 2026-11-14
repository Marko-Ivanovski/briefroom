import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AccessService } from './access.service.ts';
import { WorkspaceScopeGuard } from './workspace-scope.guard.ts';

@Global()
@Module({
  providers: [AccessService, { provide: APP_GUARD, useClass: WorkspaceScopeGuard }],
  exports: [AccessService],
})
export class AccessModule {}
