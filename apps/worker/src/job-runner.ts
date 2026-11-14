import { FILES_GC_CRON, FILES_GC_JOB, JobsService } from '@briefroom/api/worker-kit';
import { MODULE_STATE, systemScope, type ModuleState } from '@briefroom/module-kit';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Job } from 'pg-boss';
import { HandlersExplorer, type DiscoveredHandler } from './handlers.explorer.ts';

const SCHEDULES: ReadonlyArray<{ name: string; cron: string }> = [
  { name: FILES_GC_JOB, cron: FILES_GC_CRON },
];

@Injectable()
export class JobRunner {
  private readonly logger = new Logger(JobRunner.name);

  constructor(
    private readonly jobs: JobsService,
    private readonly explorer: HandlersExplorer,
    @Inject(MODULE_STATE) private readonly state: ModuleState,
  ) {}

  /** Starts pg-boss with migration off, so it throws a clear error when the app has not made the schema. */
  async start(): Promise<void> {
    const handlers = this.explorer.explore();
    await this.jobs.boss();
    for (const handler of handlers) {
      const boss = await this.jobs.ensureQueue(handler.name);
      await boss.work<object>(handler.name, { pollingIntervalSeconds: 1 }, async (batch) => {
        for (const job of batch) await this.run(handler, job);
      });
    }
    const names = new Set(handlers.map((h) => h.name));
    for (const { name, cron } of SCHEDULES) {
      if (names.has(name)) await (await this.jobs.boss()).schedule(name, cron, {});
    }
    this.logger.log(`Worker ready with ${handlers.length} job handler(s)`);
  }

  private async run(handler: DiscoveredHandler, job: Job<object>): Promise<void> {
    const payload = job.data;
    const workspaceId = (payload as { workspaceId?: unknown }).workspaceId;
    const hasWorkspace = typeof workspaceId === 'string' && workspaceId !== '';

    if (handler.moduleId !== null) {
      if (!hasWorkspace) throw new Error(`Job "${handler.name}" has no workspaceId in its payload`);
      if (!(await this.state.isEnabled(workspaceId, handler.moduleId))) {
        this.logger.log(
          `Skipped ${handler.name} job ${job.id}: module "${handler.moduleId}" is off in workspace ${workspaceId}`,
        );
        return;
      }
    }

    const context = {
      payload,
      jobId: job.id,
      ...(hasWorkspace ? { scope: systemScope(workspaceId) } : {}),
    };
    try {
      await handler.invoke(context);
    } catch (err) {
      // The payload is left out of the log, and pg-boss keeps the error with the job.
      this.logger.error(
        `${handler.name} job ${job.id} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      throw err;
    }
  }
}
