import {
  DatabaseModule,
  EnvModule,
  FilesGcJob,
  FilesService,
  HistoryService,
  JobsModule,
  ModuleRegistryService,
  REGISTERED_MODULES,
  WorkspaceModulesService,
  type Env,
} from '@briefroom/api/worker-kit';
import { FILE_STORE, HISTORY, MODULE_STATE } from '@briefroom/module-kit';
import { Global, Module, type DynamicModule } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { HandlersExplorer } from './handlers.explorer.ts';
import { JobRunner } from './job-runner.ts';

/**
 * The same core services the API provides to modules, without its controllers, auth or guards.
 * Modules reach them through the module kit tokens, exactly as they do in the API.
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
  exports: [MODULE_STATE, HISTORY, FILE_STORE],
})
class CoreServicesModule {}

@Module({})
export class WorkerModule {
  static register(env: Env): DynamicModule {
    return {
      module: WorkerModule,
      imports: [
        EnvModule.register(env),
        DatabaseModule,
        CoreServicesModule,
        JobsModule.register('worker'),
        DiscoveryModule,
        ...REGISTERED_MODULES.map((m) => m.nestModule),
      ],
      providers: [HandlersExplorer, JobRunner],
    };
  }
}
