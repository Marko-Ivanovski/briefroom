import type { Tx } from '@briefroom/db';
import type { Scope } from './scope.ts';

export interface HistoryInput {
  scope: Scope;
  /** Must be listed in the owning module's `historyTables`. */
  table: string;
  recordId: string;
  /** The record's project, or omitted for workspace-level content. Pass it on every write so a move is followed. */
  projectId?: string | null;
  /** The row before the change, or null for a creation. */
  before: object | null;
  after: object;
}

/** Implemented by the API. Provided globally, so module code never imports the API. */
export interface HistoryRecorder {
  /** Runs inside the caller's transaction. Writes nothing when no field really changed. */
  record(tx: Tx, input: HistoryInput): Promise<void>;
}

export const HISTORY = Symbol('HISTORY');
