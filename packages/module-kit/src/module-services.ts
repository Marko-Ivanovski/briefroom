import type { Provider } from '@nestjs/common';
import { CORE_EVENTS, EVENTS, type EventPublisher } from './events.ts';
import { CORE_JOBS, JOBS, type JobQueue } from './jobs.ts';

function ownPrefix(moduleId: string, name: string, what: string): void {
  if (!name.startsWith(`${moduleId}.`)) {
    throw new Error(
      `Module "${moduleId}" can only use ${what} named "${moduleId}.*", not "${name}"`,
    );
  }
}

/** An event publisher that refuses any type outside `<moduleId>.*`, whoever asks (R138). */
export function bindEvents(moduleId: string, core: EventPublisher): EventPublisher {
  return {
    publish(scope, event, tx) {
      try {
        ownPrefix(moduleId, event.type, 'event types');
      } catch (err) {
        return Promise.reject(err);
      }
      return core.publish(scope, event, tx);
    },
  };
}

/** A job queue that refuses any name outside `<moduleId>.*`. */
export function bindJobs(moduleId: string, core: JobQueue): JobQueue {
  return {
    enqueue(scope, name, payload, opts) {
      try {
        ownPrefix(moduleId, name, 'job names');
      } catch (err) {
        return Promise.reject(err);
      }
      return core.enqueue(scope, name, payload, opts);
    },
  };
}

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
