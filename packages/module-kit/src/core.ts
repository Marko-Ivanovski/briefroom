import type { EventPublisher } from './events.ts';
import type { FileRecord, FileStore, FileStoreInput } from './files.ts';
import type { HistoryRecorder } from './history.ts';
import type { JobQueue } from './jobs.ts';
import type { Scope } from './scope.ts';

/** The core's unbound services. Only the API and the worker import this file. */
export const CORE_EVENTS = Symbol('CORE_EVENTS');
export const CORE_JOBS = Symbol('CORE_JOBS');
export const CORE_FILE_STORE = Symbol('CORE_FILE_STORE');
export const CORE_HISTORY = Symbol('CORE_HISTORY');

/** The unbound file store: the caller names the owning module, and `remove` may be limited to one. */
export interface CoreFileStore {
  store(scope: Scope, input: FileStoreInput & { moduleId: string }): Promise<FileRecord>;
  /** With `moduleId`, a file owned by another module reads as missing. */
  remove(scope: Scope, fileId: string, moduleId?: string): Promise<void>;
}

/** The unbound recorder, which can also say who owns a table's history. */
export interface CoreHistory extends HistoryRecorder {
  source(table: string): { moduleId: string | null } | undefined;
}

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

/** A file store that stores and removes only under `moduleId`, and refuses any other id (R140). */
export function bindFileStore(moduleId: string, core: CoreFileStore): FileStore {
  return {
    store(scope, input) {
      if (input.moduleId !== undefined && input.moduleId !== moduleId) {
        return Promise.reject(
          new Error(
            `Module "${moduleId}" can only store files as "${moduleId}", not "${input.moduleId}"`,
          ),
        );
      }
      return core.store(scope, { ...input, moduleId });
    },
    remove(scope, fileId) {
      return core.remove(scope, fileId, moduleId);
    },
  };
}

/** A history recorder that accepts only tables the module listed in its own `historyTables` (R140). */
export function bindHistory(moduleId: string, core: CoreHistory): HistoryRecorder {
  return {
    record(tx, input) {
      if (core.source(input.table)?.moduleId !== moduleId) {
        return Promise.reject(
          new Error(
            `Module "${moduleId}" can only record history for its own tables, not "${input.table}"`,
          ),
        );
      }
      return core.record(tx, input);
    },
  };
}
