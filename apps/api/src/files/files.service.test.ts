import { existsSync } from 'node:fs';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Scope } from '../access/scope.ts';
import type { Env } from '../config/env.ts';
import type { ModuleRegistryService } from '../module-registry/module-registry.service.ts';
import type { WorkspaceModulesService } from '../module-registry/workspace-modules.service.ts';
import { FilesService } from './files.service.ts';

const scope = {
  userId: 'u1',
  workspaceId: 'ws1',
  role: 'owner',
  visibleProjectIds: 'all',
  permissions: new Set<string>(),
  actor: { userId: 'u1', via: 'web' },
} satisfies Scope;

describe('FilesService.store', () => {
  let dataDir: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'briefroom-files-unit-'));
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  const service = (transaction: () => Promise<unknown>) =>
    new FilesService(
      { transaction } as never,
      { dataDir } as Env,
      { get: () => ({}) } as unknown as ModuleRegistryService,
      { isEnabled: async () => true } as unknown as WorkspaceModulesService,
    );

  const png = () =>
    sharp({ create: { width: 800, height: 600, channels: 3, background: '#123456' } })
      .png()
      .toBuffer();

  it('deletes the written files when the row cannot be inserted', async () => {
    const failing = service(async () => {
      throw new Error('insert failed');
    });
    await expect(failing.store(scope, { moduleId: 'm', bytes: await png() })).rejects.toThrow(
      'insert failed',
    );
    const root = join(dataDir, 'files', 'ws1');
    expect(existsSync(root) ? await readdir(root) : []).toEqual([]);
  });

  it('writes nothing for an upload that is not an image', async () => {
    const never = service(async () => {
      throw new Error('must not be reached');
    });
    await expect(
      never.store(scope, { moduleId: 'm', bytes: Buffer.from('not an image') }),
    ).rejects.toMatchObject({ status: 415 });
    expect(existsSync(join(dataDir, 'files'))).toBe(false);
  });
});
