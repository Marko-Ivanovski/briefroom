import { SetMetadata } from '@nestjs/common';
import type { Scope } from './scope.ts';

export interface EnqueueOptions {
  /** A second job with the same name and key is dropped while the first is still queued or running. */
  singletonKey?: string;
}

/** Implemented by the API and the worker. Provided globally, so module code never imports an app. */
export interface JobQueue {
  /**
   * Queues a job named `<moduleId>.<name>` and returns its id. The payload must carry the
   * workspace, and the worker skips the job when the module is off there.
   */
  enqueue<T extends object>(
    name: string,
    payload: { workspaceId: string } & T,
    opts?: EnqueueOptions,
  ): Promise<string>;
}

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

/** The scope jobs run under: full reach inside one workspace, attributed to the system. */
export function systemScope(workspaceId: string): Scope {
  return {
    userId: 'system',
    workspaceId,
    role: 'owner',
    visibleProjectIds: 'all',
    permissions: new Set(),
    actor: { userId: 'system', via: 'system' },
  };
}
