import type { Provider } from '@nestjs/common';
import {
  bindEvents,
  bindFileStore,
  bindHistory,
  bindJobs,
  CORE_EVENTS,
  CORE_FILE_STORE,
  CORE_HISTORY,
  CORE_JOBS,
  type CoreFileStore,
  type CoreHistory,
} from './core.ts';
import { EVENTS, type EventPublisher } from './events.ts';
import { FILE_STORE } from './files.ts';
import { HISTORY } from './history.ts';
import { JOBS, type JobQueue } from './jobs.ts';

/**
 * Put this in the `providers` of every Nest module of the module that injects `EVENTS`, `JOBS`,
 * `FILE_STORE` or `HISTORY`. Its classes then get instances that can only act under the module's
 * id. The core's unbound instances stay behind the `CORE_*` tokens.
 */
export function provideModuleServices(moduleId: string): Provider[] {
  return [
    {
      provide: EVENTS,
      useFactory: (core: EventPublisher) => bindEvents(moduleId, core),
      inject: [CORE_EVENTS],
    },
    {
      provide: JOBS,
      useFactory: (core: JobQueue) => bindJobs(moduleId, core),
      inject: [CORE_JOBS],
    },
    {
      provide: FILE_STORE,
      useFactory: (core: CoreFileStore) => bindFileStore(moduleId, core),
      inject: [CORE_FILE_STORE],
    },
    {
      provide: HISTORY,
      useFactory: (core: CoreHistory) => bindHistory(moduleId, core),
      inject: [CORE_HISTORY],
    },
  ];
}
