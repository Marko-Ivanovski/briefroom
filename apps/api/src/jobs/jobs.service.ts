import type { EnqueueOptions, JobQueue, Scope } from '@briefroom/module-kit';
import { Inject, Injectable, Logger, type BeforeApplicationShutdown } from '@nestjs/common';
import { PgBoss, type Queue } from 'pg-boss';
import { ENV, type Env } from '../config/env.ts';
import { ModuleRegistryService } from '../module-registry/module-registry.service.ts';

export type JobsMode = 'app' | 'worker';

export const JOBS_MODE = Symbol('JOBS_MODE');

const JOB_NAME = /^(core|[a-z][a-z0-9-]{1,30})\.[a-z][a-z0-9-]*$/;
const STOP_TIMEOUT_MS = 25_000;

const RETRIES = { retryLimit: 3, retryBackoff: true } as const;

/** Module jobs retry 3 times with exponential backoff from 30 s. */
const MODULE_QUEUE_OPTIONS: Omit<Queue, 'name'> = { ...RETRIES, retryDelay: 30 };

/** `exclusive` keeps files-gc from ever overlapping itself. */
const CORE_QUEUE_OPTIONS: Readonly<Record<string, Omit<Queue, 'name'>>> = {
  'core.files-gc': { policy: 'exclusive', ...RETRIES, retryDelay: 60 },
};

export function queueOptions(name: string): Omit<Queue, 'name'> {
  return CORE_QUEUE_OPTIONS[name] ?? MODULE_QUEUE_OPTIONS;
}

export const MISSING_SCHEMA_MESSAGE =
  'The pg-boss schema is missing or out of date. Only the app process creates and migrates it: start the app once, then start the worker.';

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function newBoss(databaseUrl: string, options: { migrate: boolean; worker: boolean }): PgBoss {
  const boss = new PgBoss({
    connectionString: databaseUrl,
    max: 4,
    application_name: options.worker ? 'briefroom-worker' : 'briefroom-app',
    migrate: options.migrate,
    createSchema: options.migrate,
    // The worker runs queue maintenance and the cron timer. The app only sends.
    supervise: options.worker,
    schedule: options.worker,
  });
  boss.on('error', (err) => new Logger('Jobs').error(`pg-boss error: ${describe(err)}`));
  return boss;
}

/**
 * Creates or migrates the `pgboss` schema. Only the app process calls this, next to the Drizzle
 * migrations. The schema is pg-boss's own and never enters the Drizzle migration history.
 */
export async function migrateJobs(databaseUrl: string): Promise<void> {
  const boss = newBoss(databaseUrl, { migrate: true, worker: false });
  try {
    await boss.start();
  } finally {
    await boss.stop({ graceful: true, timeout: STOP_TIMEOUT_MS });
  }
}

/** Both processes provide this as `JOBS`. It never migrates: it starts pg-boss with migration off. */
@Injectable()
export class JobsService implements JobQueue, BeforeApplicationShutdown {
  private readonly logger = new Logger(JobsService.name);
  private starting: Promise<PgBoss> | undefined;
  private started: PgBoss | undefined;
  private readonly queues = new Set<string>();

  constructor(
    @Inject(ENV) private readonly env: Env,
    @Inject(JOBS_MODE) private readonly mode: JobsMode,
    private readonly registry: ModuleRegistryService,
  ) {}

  /** Starts pg-boss on first use, so a process that never enqueues never opens its pool. */
  boss(): Promise<PgBoss> {
    this.starting ??= this.startBoss().catch((err: unknown) => {
      this.starting = undefined;
      throw err;
    });
    return this.starting;
  }

  private async startBoss(): Promise<PgBoss> {
    const boss = newBoss(this.env.databaseUrl, { migrate: false, worker: this.mode === 'worker' });
    try {
      await boss.start();
    } catch (err) {
      await boss.stop({ graceful: false, timeout: 1000 }).catch(() => undefined);
      const message = describe(err);
      if (/pg-boss is not installed|requires migrations/.test(message)) {
        throw new Error(`${MISSING_SCHEMA_MESSAGE} (${message})`, { cause: err });
      }
      throw err;
    }
    this.started = boss;
    return boss;
  }

  /** A queue must exist before pg-boss accepts a job for it. Creating one that exists is a no-op. */
  async ensureQueue(name: string): Promise<PgBoss> {
    const boss = await this.boss();
    if (!this.queues.has(name)) {
      await boss.createQueue(name, queueOptions(name));
      this.queues.add(name);
    }
    return boss;
  }

  async enqueue<T extends object>(
    scope: Scope,
    name: string,
    payload: T,
    opts?: EnqueueOptions,
  ): Promise<string> {
    if (!JOB_NAME.test(name)) throw new Error(`"${name}" is not a job name: use <moduleId>.<name>`);
    const prefix = name.slice(0, name.indexOf('.'));
    if (prefix === 'core') throw new Error(`"${name}" is a core job: modules cannot enqueue it`);
    if (!this.registry.get(prefix)) throw new Error(`"${prefix}" is not a registered module`);
    const boss = await this.ensureQueue(name);
    const id = await boss.send(
      name,
      { ...payload, workspaceId: scope.workspaceId },
      {
        ...(opts?.singletonKey ? { singletonKey: opts.singletonKey } : {}),
      },
    );
    if (id === null) throw new Error(`Job "${name}" was not queued: the queue refused it`);
    return id;
  }

  async beforeApplicationShutdown(): Promise<void> {
    const boss = this.started;
    this.started = undefined;
    this.starting = undefined;
    if (!boss) return;
    try {
      await boss.stop({ graceful: true, timeout: STOP_TIMEOUT_MS });
    } catch (err) {
      this.logger.error(`Stopping pg-boss failed: ${describe(err)}`);
    }
  }
}
