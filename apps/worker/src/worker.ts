import type { Env } from '@briefroom/api/worker-kit';
import type { LoggerService } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { JobRunner } from './job-runner.ts';
import { WorkerModule } from './worker.module.ts';

export interface RunningWorker {
  /** Lets running jobs finish, then stops pg-boss and closes the database pool. */
  stop(): Promise<void>;
}

/** Never runs Drizzle or pg-boss migrations: the app process owns both. */
export async function startWorker(
  env: Env,
  options: { logger?: LoggerService | false } = {},
): Promise<RunningWorker> {
  const app = await NestFactory.createApplicationContext(WorkerModule.register(env), {
    abortOnError: false,
    ...(options.logger !== undefined ? { logger: options.logger } : {}),
  });
  try {
    await app.get(JobRunner).start();
  } catch (err) {
    await app.close();
    throw err;
  }
  return { stop: () => app.close() };
}
