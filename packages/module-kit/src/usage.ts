import type { Scope } from './scope.ts';

export interface UsageEvent {
  tool: string;
  itemType?: string;
  itemId?: string;
  projectId?: string;
}

/** What a module injects to log a tool call. Bound to the module's own id by `provideModuleServices`. */
export interface UsageLogger {
  /** Stores the tool name and ids only. Never pass arguments, prompts or results. */
  log(scope: Scope, event: UsageEvent): Promise<void>;
}

export const USAGE = Symbol('USAGE');
