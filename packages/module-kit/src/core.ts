import type { EventPublisher } from './events.ts';
import type { JobQueue } from './jobs.ts';

/** The core's unbound publisher and queue. Only the API and the worker import this file. */
export const CORE_EVENTS = Symbol('CORE_EVENTS');
export const CORE_JOBS = Symbol('CORE_JOBS');

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
