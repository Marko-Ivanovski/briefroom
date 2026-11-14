import { describe, expect, it, vi } from 'vitest';
import { EVENTS, JOBS, provideModuleServices, systemScope } from '../src/index.ts';
import { CORE_EVENTS, CORE_JOBS, bindEvents, bindJobs } from '../src/core.ts';

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

  it('provides EVENTS and JOBS as factories over the core instances', () => {
    const providers = provideModuleServices('testkit') as {
      provide: symbol;
      inject: symbol[];
    }[];
    expect(providers.map((p) => [p.provide, p.inject[0]])).toEqual([
      [EVENTS, CORE_EVENTS],
      [JOBS, CORE_JOBS],
    ]);
  });
});
