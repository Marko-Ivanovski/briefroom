import 'reflect-metadata';
import { loadEnv } from '@briefroom/api/worker-kit';
import { stopOnSignals } from './shutdown.ts';
import { Logger } from '@nestjs/common';
import { startWorker } from './worker.ts';

async function main(): Promise<void> {
  const env = loadEnv();
  new Logger('Env').log(`Data directory: ${env.dataDir}`);
  stopOnSignals(await startWorker(env));
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
