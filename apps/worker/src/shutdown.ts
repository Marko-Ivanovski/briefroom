import type { RunningWorker } from './worker.ts';

export interface ShutdownDeps {
  on(signal: 'SIGTERM' | 'SIGINT', listener: () => void): unknown;
  exit(code: number): void;
  log(message: string): void;
  error(err: unknown): void;
}

/** On SIGTERM or SIGINT, stops the worker once (running jobs finish, pg-boss and the pool close) and exits. */
export function stopOnSignals(
  worker: RunningWorker,
  deps: ShutdownDeps = {
    on: (signal, listener) => process.on(signal, listener),
    exit: (code) => process.exit(code),
    log: (message) => console.log(message),
    error: (err) => console.error(err),
  },
): void {
  let stopping = false;
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    deps.on(signal, () => {
      if (stopping) return;
      stopping = true;
      deps.log(`Worker received ${signal}, finishing running jobs`);
      worker.stop().then(
        () => deps.exit(0),
        (err: unknown) => {
          deps.error(err);
          deps.exit(1);
        },
      );
    });
  }
}
