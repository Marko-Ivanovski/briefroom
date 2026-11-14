import { Global, Module } from '@nestjs/common';
import { AccessService } from './access.service.ts';
import { WorkspaceScopeGuard } from './workspace-scope.guard.ts';

@Global()
@Module({
  providers: [AccessService, WorkspaceScopeGuard],
  exports: [AccessService, WorkspaceScopeGuard],
})
export class AccessModule {}
