import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JobsService, ModuleRegistryService } from '@briefroom/api/worker-kit';
import { systemScope } from '@briefroom/module-kit';
import { Logger } from '@nestjs/common';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { stopOnSignals } from '../src/shutdown.ts';
import { startWorker, type RunningWorker } from '../src/worker.ts';
import {
  createFixture,
  createNote,
  createWorkspace,
  readNote,
  until,
  type Fixture,
} from './helpers.ts';

let dataDir: string;
let fx: Fixture;
let producer: JobsService;
let worker: RunningWorker | undefined;

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'briefroom-worker-'));
  fx = await createFixture(dataDir);
  producer = new JobsService(fx.env, 'app', new ModuleRegistryService());
});

afterEach(async () => {
  await worker?.stop();
  worker = undefined;
  vi.restoreAllMocks();
});

afterAll(async () => {
  await producer.beforeApplicationShutdown();
  await fx.testDb.close();
  await rm(dataDir, { recursive: true, force: true });
});

async function jobState(jobId: string): Promise<string | undefined> {
  const { rows } = await fx.db.$client.query<{ state: string }>(
    `SELECT state FROM pgboss.job WHERE id = $1`,
    [jobId],
  );
  return rows[0]?.state;
}

describe('worker', () => {
  it('runs a module job as the system and writes pong within 5 seconds', async () => {
    const workspaceId = await createWorkspace(fx.db, { testkitOn: true });
    const noteId = await createNote(fx.db, workspaceId);
    worker = await startWorker(fx.env, { logger: false });

    await producer.enqueue(systemScope(workspaceId), 'testkit.ping', { noteId });

    const note = await until(
      async () => {
        const current = await readNote(fx.db, noteId);
        return current.text === 'pong' ? current : undefined;
      },
      5000,
      'the note to read pong',
    );
    expect(note.updatedBy).toBe('system');
    expect(note.updatedVia).toBe('system');
  });

  it('publishes an event through NOTIFY from a job, scoped to the job’s workspace', async () => {
    const workspaceId = await createWorkspace(fx.db, { testkitOn: true });
    const noteId = await createNote(fx.db, workspaceId);
    const listener = new pg.Client({ connectionString: fx.env.databaseUrl });
    const heard: string[] = [];
    await listener.connect();
    listener.on('notification', (m) => heard.push(m.payload ?? ''));
    await listener.query('LISTEN briefroom_events');
    try {
      worker = await startWorker(fx.env, { logger: false });
      await producer.enqueue(systemScope(workspaceId), 'testkit.ping', { noteId });
      const payload = await until(
        async () => heard.find((p) => p.includes('testkit.pinged')),
        5000,
        'the pinged event',
      );
      expect(JSON.parse(payload)).toEqual({
        workspaceId,
        type: 'testkit.pinged',
        payload: { noteId },
      });
    } finally {
      await listener.end();
    }
  });

  it('completes a job without running it when the module is off in that workspace', async () => {
    const workspaceId = await createWorkspace(fx.db, { testkitOn: false });
    const noteId = await createNote(fx.db, workspaceId);
    const log = vi.spyOn(Logger.prototype, 'log');
    worker = await startWorker(fx.env, { logger: false });

    const jobId = await producer.enqueue(systemScope(workspaceId), 'testkit.ping', { noteId });

    await until(
      async () => ((await jobState(jobId)) === 'completed' ? true : undefined),
      8000,
      'the job to complete',
    );
    expect((await readNote(fx.db, noteId)).text).toBe('ping');
    const skipped = log.mock.calls.filter(([message]) => String(message).startsWith('Skipped'));
    expect(skipped).toHaveLength(1);
    expect(String(skipped[0]![0])).toContain(`job ${jobId}`);
  });

  it('keeps a job inside the workspace in its payload', async () => {
    const owner = await createWorkspace(fx.db, { testkitOn: true });
    const other = await createWorkspace(fx.db, { testkitOn: true });
    const foreignNote = await createNote(fx.db, other);
    worker = await startWorker(fx.env, { logger: false });

    const jobId = await producer.enqueue(systemScope(owner), 'testkit.ping', {
      noteId: foreignNote,
    });

    await until(
      async () => ((await jobState(jobId)) === 'completed' ? true : undefined),
      8000,
      'the job to complete',
    );
    expect((await readNote(fx.db, foreignNote)).text).toBe('ping');
  });

  it('schedules the hourly files-gc job once, however many times it starts', async () => {
    worker = await startWorker(fx.env, { logger: false });
    await worker.stop();
    worker = await startWorker(fx.env, { logger: false });

    const { rows } = await fx.db.$client.query<{ name: string; cron: string }>(
      `SELECT name, cron FROM pgboss.schedule WHERE name = 'core.files-gc'`,
    );
    expect(rows).toEqual([{ name: 'core.files-gc', cron: '0 * * * *' }]);
    const { rows: queue } = await fx.db.$client.query<{ policy: string }>(
      `SELECT policy FROM pgboss.queue WHERE name = 'core.files-gc'`,
    );
    expect(queue[0]?.policy).toBe('exclusive');
  });

  it('takes the workspace from the scope, never from the payload', async () => {
    const mine = await createWorkspace(fx.db, { testkitOn: true });
    const other = await createWorkspace(fx.db, { testkitOn: true });

    const jobId = await producer.enqueue(systemScope(mine), 'testkit.ping', {
      noteId: 'x',
      workspaceId: other,
    } as { noteId: string });

    const { rows } = await fx.db.$client.query<{ data: { workspaceId: string } }>(
      `SELECT data FROM pgboss.job WHERE id = $1`,
      [jobId],
    );
    expect(rows[0]!.data.workspaceId).toBe(mine);
  });

  it('refuses core jobs and unknown prefixes from enqueue', async () => {
    const scope = systemScope(await createWorkspace(fx.db, { testkitOn: true }));

    await expect(producer.enqueue(scope, 'core.files-gc', {})).rejects.toThrow(/core/);
    await expect(producer.enqueue(scope, 'nope.thing', {})).rejects.toThrow(
      /not a registered module/,
    );
  });

  it('retries with backoff: core.files-gc and module queues', async () => {
    worker = await startWorker(fx.env, { logger: false });
    const { rows } = await fx.db.$client.query<{
      name: string;
      retry_limit: number;
      retry_delay: number;
      retry_backoff: boolean;
    }>(
      `SELECT name, retry_limit, retry_delay, retry_backoff FROM pgboss.queue
       WHERE name IN ('core.files-gc', 'testkit.ping') ORDER BY name`,
    );
    expect(rows).toEqual([
      { name: 'core.files-gc', retry_limit: 3, retry_delay: 60, retry_backoff: true },
      { name: 'testkit.ping', retry_limit: 3, retry_delay: 30, retry_backoff: true },
    ]);
  });

  it('closes its database connections when it stops', async () => {
    const count = async (): Promise<number> => {
      const { rows } = await fx.db.$client.query<{ n: string }>(
        `SELECT count(*) AS n FROM pg_stat_activity
         WHERE datname = current_database() AND pid <> pg_backend_pid()`,
      );
      return Number(rows[0]!.n);
    };
    await producer.boss();
    const before = await count();
    worker = await startWorker(fx.env, { logger: false });
    expect(await count()).toBeGreaterThan(before);

    await worker.stop();
    worker = undefined;
    const settled = await until(
      async () => ((await count()) <= before ? true : undefined),
      5000,
      'the worker connections to close',
    );
    expect(settled).toBe(true);
  });
});

describe('worker startup', () => {
  let bare: Fixture | undefined;

  afterEach(async () => {
    await bare?.testDb.close();
    bare = undefined;
  });

  it('refuses to start when the pg-boss schema is missing, and does not create it', async () => {
    bare = await createFixture(dataDir, false);

    await expect(startWorker(bare.env, { logger: false })).rejects.toThrow(
      /pg-boss schema is missing or out of date/,
    );
    const { rows } = await bare.db.$client.query(
      `SELECT 1 FROM information_schema.schemata WHERE schema_name = 'pgboss'`,
    );
    expect(rows).toHaveLength(0);
  });

  it('refuses to start when the pg-boss schema is out of date, and does not migrate it', async () => {
    bare = await createFixture(dataDir);
    await bare.db.$client.query(`UPDATE pgboss.version SET version = version - 1`);
    const { rows: before } = await bare.db.$client.query(`SELECT version FROM pgboss.version`);

    await expect(startWorker(bare.env, { logger: false })).rejects.toThrow(
      /pg-boss schema is missing or out of date/,
    );
    const { rows: after } = await bare.db.$client.query(`SELECT version FROM pgboss.version`);
    expect(after).toEqual(before);
  });
});

describe('shutdown signals', () => {
  function fakeProcess() {
    const proc = new EventEmitter();
    const exit = vi.fn();
    const stop = vi.fn(() => Promise.resolve());
    stopOnSignals(
      { stop },
      {
        on: (signal, listener) => proc.on(signal, listener),
        exit,
        log: () => undefined,
        error: () => undefined,
      },
    );
    return { proc, exit, stop };
  }

  it.each(['SIGTERM', 'SIGINT'])('stops the worker once on %s and exits 0', async (signal) => {
    const { proc, exit, stop } = fakeProcess();
    proc.emit(signal);
    proc.emit('SIGTERM');
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('exits 1 when stopping fails', async () => {
    const proc = new EventEmitter();
    const exit = vi.fn();
    stopOnSignals(
      { stop: () => Promise.reject(new Error('boom')) },
      {
        on: (signal, listener) => proc.on(signal, listener),
        exit,
        log: () => undefined,
        error: () => undefined,
      },
    );
    proc.emit('SIGTERM');
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));
  });
});
