import {
  FilesGcJob,
  FilesService,
  HistoryService,
  ModuleRegistryService,
  WorkspaceModulesService,
} from '@briefroom/api/worker-kit';
import { FILE_STORE, HISTORY, MODULE_STATE } from '@briefroom/module-kit';
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
    { provide: HISTORY, useExisting: HistoryService },
    { provide: FILE_STORE, useExisting: FilesService },
  ],
  exports: [ModuleRegistryService, MODULE_STATE, HISTORY, FILE_STORE],
})
export class CoreServicesModule {}
