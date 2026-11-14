import type { Provider } from '@nestjs/common';
import { bindEvents, bindJobs, CORE_EVENTS, CORE_JOBS } from './core.ts';
import { EVENTS, type EventPublisher } from './events.ts';
import { JOBS, type JobQueue } from './jobs.ts';

/**
 * Put this in the `providers` of the module's own Nest module. Its classes then get an `EVENTS` and
 * a `JOBS` that can only act under the module's id. The core's unbound instances stay behind
 * `CORE_EVENTS` and `CORE_JOBS`.
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
  ];
}
