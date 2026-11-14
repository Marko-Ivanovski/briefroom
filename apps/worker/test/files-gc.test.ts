import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FilesGcJob } from '@briefroom/api/worker-kit';
import { files, scopedInsert } from '@briefroom/db';
import { systemScope } from '@briefroom/module-kit';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createFixture, createWorkspace, newWorkspaceId, type Fixture } from './helpers.ts';

const HOUR = 60 * 60 * 1000;

let fx: Fixture;
let dataDir: string;
let job: FilesGcJob;

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'briefroom-gc-'));
  fx = await createFixture(dataDir, false);
  job = new FilesGcJob(fx.db, fx.env);
});

beforeEach(async () => {
  await rm(join(dataDir, 'files'), { recursive: true, force: true });
});

afterAll(async () => {
  await fx.testDb.close();
  await rm(dataDir, { recursive: true, force: true });
});

async function makeDir(path: string, ageMs: number): Promise<void> {
  await mkdir(path, { recursive: true });
  await writeFile(join(path, 'original'), 'bytes');
  const then = new Date(Date.now() - ageMs);
  await utimes(path, then, then);
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

describe('core.files-gc', () => {
  it('removes an orphan directory older than one hour', async () => {
    const ws = await createWorkspace(fx.db);
    const dir = join(dataDir, 'files', ws, randomUUID());
    await makeDir(dir, 2 * HOUR);

    const removed = await job.sweep();

    expect(removed).toHaveLength(1);
    expect(await exists(dir)).toBe(false);
  });

  it('keeps a fresh orphan, which may be a write in flight', async () => {
    const ws = await createWorkspace(fx.db);
    const dir = join(dataDir, 'files', ws, randomUUID());
    await makeDir(dir, 5 * 60 * 1000);

    expect(await job.sweep()).toEqual([]);
    expect(await exists(dir)).toBe(true);
  });

  it('keeps a directory that has a files row, however old', async () => {
    const ws = await createWorkspace(fx.db);
    const id = randomUUID();
    await fx.db.insert(files).values({
      id,
      ...scopedInsert(systemScope(ws), {
        moduleId: 'testkit',
        mime: 'image/png',
        bytes: 5,
        sha256: 'x',
        width: 1,
        height: 1,
      }),
    });
    const dir = join(dataDir, 'files', ws, id);
    await makeDir(dir, 48 * HOUR);

    expect(await job.sweep()).toEqual([]);
    expect(await exists(dir)).toBe(true);
  });

  it('leaves a directory whose name is not a uuid alone, however old', async () => {
    const ws = await createWorkspace(fx.db);
    const odd = join(dataDir, 'files', ws, 'not-a-uuid');
    const stray = join(dataDir, 'files', 'notes');
    await makeDir(odd, 48 * HOUR);
    await makeDir(stray, 48 * HOUR);

    expect(await job.sweep()).toEqual([]);
    expect(await exists(odd)).toBe(true);
    expect(await exists(stray)).toBe(true);
  });

  it('removes the directory of a workspace that no longer exists', async () => {
    const gone = newWorkspaceId();
    const dir = join(dataDir, 'files', gone);
    await makeDir(join(dir, randomUUID()), 0);

    expect(await job.sweep()).toEqual([gone]);
    expect(await exists(dir)).toBe(false);
  });

  it('keeps the other workspaces when it removes one', async () => {
    const ws = await createWorkspace(fx.db);
    const keep = join(dataDir, 'files', ws, randomUUID());
    await makeDir(keep, 0);
    await makeDir(join(dataDir, 'files', newWorkspaceId(), randomUUID()), 0);

    await job.sweep();

    expect(await exists(keep)).toBe(true);
  });

  it('never follows a symlink out of the files folder', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'briefroom-outside-'));
    await writeFile(join(outside, 'precious'), 'keep me');
    const ws = await createWorkspace(fx.db);
    const gone = newWorkspaceId();
    await mkdir(join(dataDir, 'files', ws), { recursive: true });
    await mkdir(join(dataDir, 'files'), { recursive: true });
    try {
      await symlink(outside, join(dataDir, 'files', ws, randomUUID()), 'junction');
      await symlink(outside, join(dataDir, 'files', gone), 'junction');
    } catch {
      await rm(outside, { recursive: true, force: true });
      return;
    }
    const old = new Date(Date.now() - 48 * HOUR);
    await utimes(join(dataDir, 'files', ws), old, old);

    expect(await job.sweep()).toEqual([]);
    expect(await exists(join(outside, 'precious'))).toBe(true);
    await rm(outside, { recursive: true, force: true });
  });

  it('does nothing when no file was ever stored', async () => {
    expect(await job.sweep()).toEqual([]);
  });
});
