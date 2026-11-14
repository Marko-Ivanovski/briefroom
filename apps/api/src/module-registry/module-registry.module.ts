import { MODULE_STATE } from '@briefroom/module-kit';
import { Global, Module } from '@nestjs/common';
import { MemberPermissionsService } from './member-permissions.service.ts';
import { ModuleRegistryService } from './module-registry.service.ts';
import { ModulesController } from './modules.controller.ts';
import { PermissionsController } from './permissions.controller.ts';
import { WorkspaceModulesService } from './workspace-modules.service.ts';

@Global()
@Module({
  controllers: [ModulesController, PermissionsController],
  providers: [
    ModuleRegistryService,
    WorkspaceModulesService,
    MemberPermissionsService,
    { provide: MODULE_STATE, useExisting: WorkspaceModulesService },
  ],
  exports: [ModuleRegistryService, WorkspaceModulesService, MemberPermissionsService, MODULE_STATE],
})
export class ModuleRegistryModule {}
