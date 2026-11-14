import { OnJob } from '@briefroom/module-kit';
import { Module } from '@nestjs/common';
import type { DiscoveryService } from '@nestjs/core';
import { describe, expect, it, vi } from 'vitest';
import { CoreServicesModule } from '../src/core-services.module.ts';
import { HandlersExplorer } from '../src/handlers.explorer.ts';
import { JobRunner } from '../src/job-runner.ts';

class Stranger {
  @OnJob('other.steal')
  steal(): void {}
}

class Claimant {
  @OnJob('fix.thing')
  thing(): void {}
}

class Nested {
  @OnJob('fix.deep')
  deep(): void {}
}

class CoreHandler {
  @OnJob('core.tidy')
  tidy(): void {}
}

class WrongCore {
  @OnJob('fix.thing')
  thing(): void {}
}

@Module({ providers: [Nested] })
class DeepModule {}

@Module({ imports: [DeepModule] })
class SubModule {}

@Module({ imports: [{ module: SubModule }] })
class FixtureModule {}

@Module({})
class LooseModule {}

const registered = [{ manifest: { id: 'fix' }, nestModule: FixtureModule }];

function explorerFor(...providers: Array<{ instance: object; module?: unknown }>) {
  const discovery = {
    getProviders: () =>
      providers.map((p) => ({ instance: p.instance, host: { metatype: p.module } })),
  } as unknown as DiscoveryService;
  return new HandlersExplorer(discovery);
}

describe('handlers explorer', () => {
  it('finds a module handler and a core handler', () => {
    const found = explorerFor(
      { instance: new Claimant(), module: FixtureModule },
      { instance: new CoreHandler(), module: CoreServicesModule },
    ).explore(registered);

    expect(found.map((h) => [h.name, h.moduleId])).toEqual([
      ['fix.thing', 'fix'],
      ['core.tidy', null],
    ]);
  });

  it('gives a handler in a nested module the registered module id', () => {
    const found = explorerFor({ instance: new Nested(), module: DeepModule }).explore(registered);

    expect(found.map((h) => [h.name, h.moduleId])).toEqual([['fix.deep', 'fix']]);
  });

  it('refuses a handler whose host is neither core nor in a registered module', () => {
    expect(() =>
      explorerFor({ instance: new Claimant(), module: LooseModule }).explore(registered),
    ).toThrow(/not part of the core or a registered module/);
    expect(() => explorerFor({ instance: new CoreHandler() }).explore(registered)).toThrow(
      /not part of the core or a registered module/,
    );
  });

  it('refuses a module handler named for another module', () => {
    expect(() =>
      explorerFor({ instance: new Stranger(), module: SubModule }).explore(registered),
    ).toThrow(/must be named "fix\.\*"/);
  });

  it('refuses a core handler that claims a module job name', () => {
    expect(() =>
      explorerFor({ instance: new WrongCore(), module: CoreServicesModule }).explore(registered),
    ).toThrow(/must be named "core\.\*"/);
  });

  it('refuses two handlers for one job name', () => {
    expect(() =>
      explorerFor(
        { instance: new Claimant(), module: FixtureModule },
        { instance: new Claimant(), module: SubModule },
      ).explore(registered),
    ).toThrow(/Two handlers claim/);
  });

  it('applies the module-off check to a nested handler', async () => {
    const handler = explorerFor({ instance: new Nested(), module: DeepModule }).explore(
      registered,
    )[0]!;
    const invoke = vi.spyOn(handler, 'invoke');
    const isEnabled = vi.fn(() => Promise.resolve(false));
    const runner = new JobRunner({} as never, {} as never, { isEnabled, settings: vi.fn() });

    await (
      runner as unknown as {
        run(h: unknown, job: unknown): Promise<void>;
      }
    ).run(handler, { id: 'job-1', data: { workspaceId: 'ws' } });

    expect(isEnabled).toHaveBeenCalledWith('ws', 'fix');
    expect(invoke).not.toHaveBeenCalled();
  });
});
