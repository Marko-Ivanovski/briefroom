import { SetMetadata } from '@nestjs/common';
import type { Scope } from './scope.ts';

/** No options yet: deduplication isn't offered, because module queues don't drop duplicates. */
export type EnqueueOptions = Record<string, never>;

/** Implemented by the API and the worker. Modules get one bound to their own id, so they never import an app. */
export interface JobQueue {
  /**
   * Queues a job named `<moduleId>.<name>` and returns its id. The job's workspace is always
   * `scope.workspaceId`, whatever the payload holds. A `core.*` name or an unregistered module
   * prefix is refused. The worker skips the job when the module is off in that workspace.
   *
   * A job carries no user: its handler runs as the system with `'all'` visibility. Check every id
   * you put in the payload against the caller's own scope before enqueueing.
   */
  enqueue<T extends object>(
    scope: Scope,
    name: string,
    payload: T,
    opts?: EnqueueOptions,
  ): Promise<string>;
}

/** What a module injects. Bound to the module's own id by `provideModuleServices` (R138). */
export const JOBS = Symbol('JOBS');

export interface JobContext<T extends object = object> {
  payload: { workspaceId: string } & T;
  jobId: string;
  /** A system scope for the payload's workspace, so handlers write with scopedInsert and scopedUpdate. */
  scope: Scope;
}

/** What a scheduled, install-wide `core.*` job receives: there is no workspace to scope it to. */
export interface InstallJobContext {
  payload: object;
  jobId: string;
}

export const ON_JOB = 'briefroom:on-job';

/**
 * Marks a provider method as the handler of one job name. The worker finds these, so a handler
 * only runs where the worker loads its module. A module's handlers must be named `<moduleId>.*`.
 */
export const OnJob = (name: string): MethodDecorator => SetMetadata(ON_JOB, name);

/**
 * The scope jobs run under: full reach inside one workspace, attributed to the system. Pass every
 * registered permission key to match an owner, which is what the worker does.
 */
export function systemScope(workspaceId: string, permissions: Iterable<string> = []): Scope {
  return {
    userId: 'system',
    workspaceId,
    role: 'owner',
    visibleProjectIds: 'all',
    permissions: new Set(permissions),
    actor: { userId: 'system', via: 'system' },
  };
}
