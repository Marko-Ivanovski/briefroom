import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FilesGcJob, MAX_WORKSPACE_REMOVALS } from '@briefroom/api/worker-kit';
import { files, scopedInsert, type Db } from '@briefroom/db';
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

  it('removes the old directory of a workspace that no longer exists', async () => {
    await createWorkspace(fx.db);
    const gone = newWorkspaceId();
    const dir = join(dataDir, 'files', gone);
    await makeDir(join(dir, randomUUID()), 0);
    const old = new Date(Date.now() - 2 * HOUR);
    await utimes(dir, old, old);

    expect(await job.sweep()).toEqual([gone]);
    expect(await exists(dir)).toBe(false);
  });

  it('keeps a fresh directory of a workspace that no longer exists', async () => {
    await createWorkspace(fx.db);
    const dir = join(dataDir, 'files', newWorkspaceId());
    await makeDir(join(dir, randomUUID()), 0);

    expect(await job.sweep()).toEqual([]);
    expect(await exists(dir)).toBe(true);
  });

  it('deletes nothing when the organization table is empty but directories exist', async () => {
    await fx.db.$client.query('DELETE FROM organization');
    const dir = join(dataDir, 'files', newWorkspaceId());
    await makeDir(join(dir, randomUUID()), 48 * HOUR);
    await utimes(dir, new Date(Date.now() - 48 * HOUR), new Date(Date.now() - 48 * HOUR));

    expect(await job.sweep()).toEqual([]);
    expect(await exists(dir)).toBe(true);
  });

  it('removes at most 5 whole workspaces per run', async () => {
    await createWorkspace(fx.db);
    const old = new Date(Date.now() - 2 * HOUR);
    const dirs: string[] = [];
    for (let i = 0; i < 7; i++) {
      const dir = join(dataDir, 'files', newWorkspaceId());
      await makeDir(join(dir, randomUUID()), 0);
      await utimes(dir, old, old);
      dirs.push(dir);
    }

    expect(await job.sweep()).toHaveLength(MAX_WORKSPACE_REMOVALS);
    const left = (await Promise.all(dirs.map(exists))).filter(Boolean);
    expect(left).toHaveLength(2);
    expect(await job.sweep()).toHaveLength(2);
  });

  it('aborts and deletes nothing when the database fails', async () => {
    const ws = await createWorkspace(fx.db);
    const dir = join(dataDir, 'files', ws, randomUUID());
    await makeDir(dir, 48 * HOUR);
    const broken = new FilesGcJob(
      { select: () => ({ from: () => Promise.reject(new Error('db down')) }) } as unknown as Db,
      fx.env,
    );

    await expect(broken.sweep()).rejects.toThrow('db down');
    expect(await exists(dir)).toBe(true);
  });

  it('skips the run when the files root is a symlink', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'briefroom-root-'));
    await createWorkspace(fx.db);
    const victim = join(outside, newWorkspaceId());
    await makeDir(join(victim, randomUUID()), 48 * HOUR);
    await utimes(victim, new Date(Date.now() - 48 * HOUR), new Date(Date.now() - 48 * HOUR));
    await mkdir(dataDir, { recursive: true });
    try {
      await symlink(outside, join(dataDir, 'files'), 'junction');
    } catch {
      await rm(outside, { recursive: true, force: true });
      return;
    }

    expect(await job.sweep()).toEqual([]);
    expect(await exists(victim)).toBe(true);
    await rm(join(dataDir, 'files'), { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  it('keeps the other workspaces when it removes one', async () => {
    const ws = await createWorkspace(fx.db);
    const keep = join(dataDir, 'files', ws, randomUUID());
    await makeDir(keep, 0);
    const dir = join(dataDir, 'files', newWorkspaceId());
    await makeDir(join(dir, randomUUID()), 0);
    await utimes(dir, new Date(Date.now() - 2 * HOUR), new Date(Date.now() - 2 * HOUR));

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
