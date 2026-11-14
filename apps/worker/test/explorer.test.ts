import { REGISTERED_MODULES } from '@briefroom/api/worker-kit';
import { OnJob } from '@briefroom/module-kit';
import type { DiscoveryService } from '@nestjs/core';
import { describe, expect, it } from 'vitest';
import { HandlersExplorer } from '../src/handlers.explorer.ts';

const testkit = REGISTERED_MODULES.find((m) => m.manifest.id === 'testkit')!;

class Stranger {
  @OnJob('other.steal')
  steal(): void {}
}

class Claimant {
  @OnJob('testkit.thing')
  thing(): void {}
}

class CoreHandler {
  @OnJob('core.tidy')
  tidy(): void {}
}

class WrongCore {
  @OnJob('testkit.thing')
  thing(): void {}
}

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
      { instance: new Claimant(), module: testkit.nestModule },
      { instance: new CoreHandler() },
    ).explore();

    expect(found.map((h) => [h.name, h.moduleId])).toEqual([
      ['testkit.thing', 'testkit'],
      ['core.tidy', null],
    ]);
  });

  it('refuses a module handler named for another module', () => {
    expect(() =>
      explorerFor({ instance: new Stranger(), module: testkit.nestModule }).explore(),
    ).toThrow(/must be named "testkit\.\*"/);
  });

  it('refuses a core handler that claims a module job name', () => {
    expect(() => explorerFor({ instance: new WrongCore() }).explore()).toThrow(
      /must be named "core\.\*"/,
    );
  });

  it('refuses two handlers for one job name', () => {
    expect(() =>
      explorerFor(
        { instance: new Claimant(), module: testkit.nestModule },
        { instance: new Claimant(), module: testkit.nestModule },
      ).explore(),
    ).toThrow(/Two handlers claim/);
  });
});
