import 'reflect-metadata';
import { loadEnv } from '@briefroom/api/worker-kit';
import { stopOnSignals } from './shutdown.ts';
import { startWorker } from './worker.ts';

async function main(): Promise<void> {
  stopOnSignals(await startWorker(loadEnv()));
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
