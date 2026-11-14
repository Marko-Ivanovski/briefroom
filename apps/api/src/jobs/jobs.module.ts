import { CORE_JOBS } from '@briefroom/module-kit';
import { Global, Module, type DynamicModule } from '@nestjs/common';
import { JOBS_MODE, JobsService, type JobsMode } from './jobs.service.ts';

@Global()
@Module({})
export class JobsModule {
  static register(mode: JobsMode): DynamicModule {
    return {
      module: JobsModule,
      providers: [
        { provide: JOBS_MODE, useValue: mode },
        JobsService,
        { provide: CORE_JOBS, useExisting: JobsService },
      ],
      exports: [CORE_JOBS, JobsService],
    };
  }
}
