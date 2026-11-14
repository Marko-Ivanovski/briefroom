import { ModuleRegistryService, type JobsService } from '@briefroom/api/worker-kit';
import { hasPermission, systemScope, type ModuleState } from '@briefroom/module-kit';
import { describe, expect, it } from 'vitest';
import type { HandlersExplorer } from '../src/handlers.explorer.ts';
import { JobRunner } from '../src/job-runner.ts';

describe('the scope a job runs under', () => {
  it('holds every registered permission, like an owner, so shared code is not refused', async () => {
    const registry = new ModuleRegistryService();
    const state: ModuleState = { isEnabled: async () => true, settings: async () => ({}) as never };
    const runner = new JobRunner({} as JobsService, {} as HandlersExplorer, state, registry);
    let seen: { scope: ReturnType<typeof systemScope> } | undefined;
    const handler = {
      name: 'testkit.ping',
      moduleId: 'testkit',
      invoke: async (context: object) => {
        seen = context as typeof seen;
      },
    };

    await runner['run'](handler, { id: 'j1', data: { workspaceId: 'w' } } as never);

    expect(seen!.scope).toMatchObject({
      workspaceId: 'w',
      role: 'owner',
      visibleProjectIds: 'all',
    });
    expect(hasPermission(seen!.scope, 'testkit', 'write-notes')).toBe(true);
    const keys = registry
      .list()
      .flatMap(({ manifest }) => manifest.permissions.map((p) => `${manifest.id}:${p.key}`));
    expect(keys.length).toBeGreaterThan(0);
    expect([...seen!.scope.permissions].sort()).toEqual(keys.sort());
  });

  it('systemScope takes the permission keys to hold, and none by default', () => {
    expect(systemScope('w').permissions.size).toBe(0);
    expect(hasPermission(systemScope('w', ['a:b']), 'a', 'b')).toBe(true);
  });
});
