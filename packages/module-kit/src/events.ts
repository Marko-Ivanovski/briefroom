import type { Tx } from '@briefroom/db';
import type { Scope } from './scope.ts';

export interface EventInput {
  /** Leave out for a workspace-level event. Only people who can see the project receive a project event. */
  projectId?: string;
  /** `<moduleId>.<name>`, for example `notes.created`. */
  type: string;
  /** A small notification, at most 6 KB with the envelope. Clients refetch the details. */
  payload?: unknown;
}

/** Implemented by the API and the worker. Modules get one bound to their own id, so they never import an app. */
export interface EventPublisher {
  /**
   * Sends an event to the open streams of `scope.workspaceId`, whatever the event holds. A `core.*`
   * type or a prefix that is not a registered module is refused. Pass `tx` to publish inside the
   * caller's transaction: a rollback then emits nothing.
   */
  publish(scope: Scope, event: EventInput, tx?: Tx): Promise<void>;
}

/** What a module injects. Bound to the module's own id by `provideModuleServices` (R138). */
export const EVENTS = Symbol('EVENTS');
