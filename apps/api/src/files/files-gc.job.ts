import { authSchema, files, type Db } from '@briefroom/db';
import { DB, OnJob } from '@briefroom/module-kit';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq, inArray } from 'drizzle-orm';
import { lstat, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { ENV, type Env } from '../config/env.ts';

export const FILES_GC_JOB = 'core.files-gc';
export const FILES_GC_CRON = '0 * * * *';

/** A directory this young may still be a write in flight, whose row is not committed yet. */
export const ORPHAN_MIN_AGE_MS = 60 * 60 * 1000;

/** A run removes at most this many whole workspace directories, so a mistake cannot wipe the store. */
export const MAX_WORKSPACE_REMOVALS = 5;

// Better Auth makes workspace ids as 32 random letters and digits, and the store makes file ids
// with randomUUID(). Anything else under the data dir is not ours, so it is never touched.
const WORKSPACE_ID = /^[A-Za-z0-9]{32}$/;
const FILE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Removes file directories the database no longer knows: a store that crashed between writing
 * and inserting, or a workspace deleted with its rows cascaded. Paths are built only from names
 * that match the two id patterns and are checked with lstat, so a symlink is never followed.
 */
@Injectable()
export class FilesGcJob {
  private readonly logger = new Logger(FilesGcJob.name);

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(ENV) private readonly env: Env,
  ) {}

  @OnJob(FILES_GC_JOB)
  async run(): Promise<void> {
    const removed = await this.sweep();
    this.logger.log(
      `files-gc removed ${removed.length} orphaned director${removed.length === 1 ? 'y' : 'ies'}`,
    );
  }

  /** Returns the removed paths, relative to the data dir's `files` folder. */
  async sweep(now: number = Date.now()): Promise<string[]> {
    const root = join(this.env.dataDir, 'files');
    const rootStat = await lstat(root).catch((err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') return undefined;
      throw err;
    });
    if (!rootStat) return [];
    if (!rootStat.isDirectory()) {
      this.logger.warn(`files-gc skipped: ${root} is not a real directory`);
      return [];
    }
    const workspaces = await this.childDirs(root, WORKSPACE_ID);
    if (workspaces.length === 0) return [];

    const known = new Set(
      (await this.db.select({ id: authSchema.organization.id }).from(authSchema.organization)).map(
        (row) => row.id,
      ),
    );
    // No workspace at all while directories exist means the wrong database, not an empty install.
    if (known.size === 0) {
      this.logger.warn(
        'files-gc aborted: no workspaces in the database but file directories exist',
      );
      return [];
    }
    const removed: string[] = [];
    let wholeRemovals = 0;
    let deferred = 0;
    for (const workspaceId of workspaces) {
      const workspaceDir = join(root, workspaceId);
      if (!known.has(workspaceId)) {
        const stat = await lstat(workspaceDir).catch(() => undefined);
        if (!stat?.isDirectory() || now - stat.mtimeMs <= ORPHAN_MIN_AGE_MS) continue;
        if (wholeRemovals >= MAX_WORKSPACE_REMOVALS) {
          deferred++;
          continue;
        }
        wholeRemovals++;
        await this.remove(workspaceDir, workspaceId, removed);
        continue;
      }
      const old: string[] = [];
      for (const fileId of await this.childDirs(workspaceDir, FILE_ID)) {
        const stat = await lstat(join(workspaceDir, fileId)).catch(() => undefined);
        if (stat?.isDirectory() && now - stat.mtimeMs > ORPHAN_MIN_AGE_MS) old.push(fileId);
      }
      if (old.length === 0) continue;
      const rows = await this.db
        .select({ id: files.id })
        .from(files)
        .where(and(eq(files.workspaceId, workspaceId), inArray(files.id, old)));
      const kept = new Set(rows.map((row) => row.id));
      for (const fileId of old) {
        if (!kept.has(fileId)) {
          await this.remove(join(workspaceDir, fileId), `${workspaceId}/${fileId}`, removed);
        }
      }
    }
    if (deferred > 0) {
      this.logger.warn(`files-gc left ${deferred} orphaned workspace directories for the next run`);
    }
    return removed;
  }

  /** Real directories directly under `parent` whose names match `pattern`. A symlink never counts. */
  private async childDirs(parent: string, pattern: RegExp): Promise<string[]> {
    let names: string[];
    try {
      names = await readdir(parent);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
    const dirs: string[] = [];
    for (const name of names) {
      if (!pattern.test(name)) continue;
      const stat = await lstat(join(parent, name)).catch(() => undefined);
      if (stat?.isDirectory()) dirs.push(name);
    }
    return dirs;
  }

  private async remove(path: string, label: string, removed: string[]): Promise<void> {
    await rm(path, { recursive: true, force: true });
    removed.push(label);
    this.logger.log(`Removed orphaned file directory files/${label}`);
  }
}
