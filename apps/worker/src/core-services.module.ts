import {
  FilesGcJob,
  FilesService,
  HistoryService,
  ModuleRegistryService,
  WorkspaceModulesService,
} from '@briefroom/api/worker-kit';
import { MODULE_STATE } from '@briefroom/module-kit';
import { CORE_FILE_STORE, CORE_HISTORY } from '@briefroom/module-kit/core';
import { Global, Module } from '@nestjs/common';

/**
 * The same core services the API provides to modules, without its controllers, auth or guards.
 * Modules reach them through the module kit tokens, exactly as they do in the API. Handlers
 * hosted here are the core's own.
 */
@Global()
@Module({
  providers: [
    ModuleRegistryService,
    WorkspaceModulesService,
    HistoryService,
    FilesService,
    FilesGcJob,
    { provide: MODULE_STATE, useExisting: WorkspaceModulesService },
    { provide: CORE_HISTORY, useExisting: HistoryService },
    { provide: CORE_FILE_STORE, useExisting: FilesService },
  ],
  exports: [ModuleRegistryService, MODULE_STATE, CORE_HISTORY, CORE_FILE_STORE],
})
export class CoreServicesModule {}
