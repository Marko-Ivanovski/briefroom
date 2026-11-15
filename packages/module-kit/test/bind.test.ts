import { describe, expect, it, vi } from 'vitest';
import {
  EVENTS,
  FILE_STORE,
  HISTORY,
  JOBS,
  provideModuleServices,
  systemScope,
} from '../src/index.ts';
import {
  CORE_EVENTS,
  CORE_FILE_STORE,
  CORE_HISTORY,
  CORE_JOBS,
  bindEvents,
  bindFileStore,
  bindHistory,
  bindJobs,
  type CoreFileStore,
} from '../src/core.ts';

const scope = systemScope('w');

describe('per-module publisher and queue (R138)', () => {
  it('lets a module publish its own types and refuses every other prefix', async () => {
    const core = { publish: vi.fn(async () => undefined) };
    const events = bindEvents('testkit', core);
    await events.publish(scope, { type: 'testkit.note_created' });
    expect(core.publish).toHaveBeenCalledTimes(1);
    for (const type of ['other.x', 'core.x', 'testkitx.y', 'nodot']) {
      await expect(events.publish(scope, { type })).rejects.toThrow(/testkit/);
    }
    expect(core.publish).toHaveBeenCalledTimes(1);
  });

  it('lets a module enqueue its own jobs and refuses every other prefix', async () => {
    const core = { enqueue: vi.fn(async () => 'id') };
    const jobs = bindJobs('testkit', core);
    await expect(jobs.enqueue(scope, 'testkit.ping', {})).resolves.toBe('id');
    for (const name of ['other.x', 'core.files-gc', 'nodot']) {
      await expect(jobs.enqueue(scope, name, {})).rejects.toThrow(/testkit/);
    }
    expect(core.enqueue).toHaveBeenCalledTimes(1);
  });
});

describe('module job options (R141)', () => {
  it('does not accept a singletonKey, because module queues do not deduplicate', async () => {
    const jobs = bindJobs('testkit', { enqueue: vi.fn(async () => 'id') });
    // @ts-expect-error `singletonKey` is not an option: nothing would drop the second job
    await jobs.enqueue(scope, 'testkit.ping', {}, { singletonKey: 'x' });
  });
});

describe('per-module file store and history (R140)', () => {
  const input = { bytes: Buffer.alloc(0) };

  it('stores and removes only under the module id, and refuses any other id', async () => {
    const core = {
      store: vi.fn<CoreFileStore['store']>(async () => ({}) as never),
      remove: vi.fn<CoreFileStore['remove']>(async () => undefined),
    };
    const files = bindFileStore('testkit', core);
    await files.store(scope, input);
    await files.store(scope, { ...input, moduleId: 'testkit' });
    expect(core.store.mock.calls.map((c) => c[1].moduleId)).toEqual(['testkit', 'testkit']);
    await expect(files.store(scope, { ...input, moduleId: 'design' })).rejects.toThrow(/testkit/);
    expect(core.store).toHaveBeenCalledTimes(2);
    await files.remove(scope, 'f');
    expect(core.remove).toHaveBeenCalledWith(scope, 'f', 'testkit');
  });

  it('records history only for tables the module owns', async () => {
    const owners: Record<string, { moduleId: string | null }> = {
      testkit_notes: { moduleId: 'testkit' },
      design_entries: { moduleId: 'design' },
      core_table: { moduleId: null },
    };
    const core = { record: vi.fn(async () => undefined), source: (t: string) => owners[t] };
    const history = bindHistory('testkit', core);
    const write = (table: string) =>
      history.record({} as never, { scope, table, recordId: 'r', before: null, after: {} });
    await write('testkit_notes');
    for (const table of ['design_entries', 'core_table', 'nobody_owns']) {
      await expect(write(table)).rejects.toThrow(/testkit/);
    }
    expect(core.record).toHaveBeenCalledTimes(1);
  });

  it('provides EVENTS, JOBS, FILE_STORE and HISTORY as factories over the core instances', () => {
    const providers = provideModuleServices('testkit') as {
      provide: symbol;
      inject: symbol[];
    }[];
    expect(providers.map((p) => [p.provide, p.inject[0]])).toEqual([
      [EVENTS, CORE_EVENTS],
      [JOBS, CORE_JOBS],
      [FILE_STORE, CORE_FILE_STORE],
      [HISTORY, CORE_HISTORY],
    ]);
  });
});
