import {
  DatabaseModule,
  EnvModule,
  EventsModule,
  JobsModule,
  REGISTERED_MODULES,
  type Env,
} from '@briefroom/api/worker-kit';
import { Module, type DynamicModule } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { CoreServicesModule } from './core-services.module.ts';
import { HandlersExplorer } from './handlers.explorer.ts';
import { JobRunner } from './job-runner.ts';

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
        EventsModule.register('worker'),
        DiscoveryModule,
        ...REGISTERED_MODULES.map((m) => m.nestModule),
      ],
      providers: [HandlersExplorer, JobRunner],
    };
  }
}
