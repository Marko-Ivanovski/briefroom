import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ReadStream } from 'node:fs';
import { files, projects, scoped, scopedInsert, scopedProjects, type Db } from '@briefroom/db';
import {
  DEFAULT_UPLOAD_LIMITS,
  MAX_UPLOAD_BYTES,
  type UploadLimits,
  type FileRecord,
  type FileStoreInput,
} from '@briefroom/module-kit';
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  PayloadTooLargeException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import type { CoreFileStore } from '@briefroom/module-kit/core';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Scope } from '../access/scope.ts';
import { ENV, type Env } from '../config/env.ts';
import { DB } from '../database/database.module.ts';
import { ModuleRegistryService } from '../module-registry/module-registry.service.ts';
import { WorkspaceModulesService } from '../module-registry/workspace-modules.service.ts';
import { ImageRejected, makeVariants } from './image.ts';
import { BusyException } from '../errors/busy.ts';
import { ByteBudget } from './byte-budget.ts';
import { Semaphore } from './semaphore.ts';

/** A queued body read that has waited this long is refused with 503, so wait plus read fits requestTimeout. */
export const READER_WAIT_MS = 20_000;

export type FileSize = 'thumb' | 'reduced' | 'original';

export interface FileStream {
  stream: ReadStream;
  mime: string;
  length: number;
}

const moduleOff = (moduleId: string) =>
  new ConflictException({
    code: 'module_off',
    moduleId,
    message: 'This module is switched off in this workspace',
  });

@Injectable()
export class FilesService implements CoreFileStore {
  private readonly log = new Logger('Files');
  /** Process-wide and replaceable by tests: four body reads at once, eight waiting, then 503. */
  readers = new Semaphore(4, 8, READER_WAIT_MS);
  /** Two image jobs at once, eight waiting, then 503. Never held while a client is sending. */
  jobs = new Semaphore(2, 8);
  readLimits: UploadLimits = DEFAULT_UPLOAD_LIMITS;
  /** Every upload body in flight, read, waiting or processing, fits in 80 MB together. */
  budget = new ByteBudget(80 * 1024 * 1024);

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(ENV) private readonly env: Env,
    private readonly registry: ModuleRegistryService,
    private readonly modules: WorkspaceModulesService,
  ) {}

  /** Built only from ids that came out of the database, never from a request. */
  private dir(workspaceId: string, fileId: string): string {
    return join(this.env.dataDir, 'files', workspaceId, fileId);
  }

  async store(scope: Scope, input: FileStoreInput & { moduleId: string }): Promise<FileRecord> {
    const { moduleId, projectId } = input;
    if (!this.registry.get(moduleId)) throw new BadRequestException('Unknown module');
    if (!(await this.modules.isEnabled(scope.workspaceId, moduleId))) throw moduleOff(moduleId);
    if (projectId) {
      const [visible] = await this.db
        .select({ id: projects.id })
        .from(projects)
        .where(and(scopedProjects(scope), eq(projects.id, projectId)));
      if (!visible) throw new NotFoundException('Project not found');
    }
    const { bytes: source } = input;
    if (typeof source !== 'function') {
      return this.process(scope, moduleId, projectId, source);
    }
    // Reserved before a byte is read, and held until the file is saved or the upload fails.
    const release = this.budget.reserve(
      Math.min(source.declaredBytes ?? MAX_UPLOAD_BYTES, MAX_UPLOAD_BYTES),
    );
    if (!release) throw new BusyException();
    try {
      // Two stages. A slow client only ever holds a reader permit, never an image slot.
      const bytes = await this.readers.run(() => source(this.readLimits));
      return await this.process(scope, moduleId, projectId, bytes);
    } finally {
      release();
    }
  }

  /**
   * Visibility comes from `scoped()`, so an invisible file, a missing one and (with `moduleId`) one
   * owned by another module are all the same 404. The row goes first. A failed removal on disk only
   * leaves an orphan directory, which `core.files-gc` collects.
   */
  async remove(scope: Scope, fileId: string, moduleId?: string): Promise<void> {
    if (!z.uuid().safeParse(fileId).success) throw new NotFoundException('File not found');
    const [row] = await this.db.transaction((tx) =>
      tx
        .delete(files)
        .where(
          and(
            scoped(scope, files),
            eq(files.id, fileId),
            moduleId === undefined ? undefined : eq(files.moduleId, moduleId),
          ),
        )
        .returning({ id: files.id, workspaceId: files.workspaceId }),
    );
    if (!row) throw new NotFoundException('File not found');
    await rm(this.dir(row.workspaceId, row.id), { recursive: true, force: true }).catch(
      (err: unknown) =>
        this.log.error(
          `File ${row.id} was removed but its directory was not: ${err instanceof Error ? err.message : String(err)}`,
        ),
    );
  }

  private process(
    scope: Scope,
    moduleId: string,
    projectId: string | undefined,
    bytes: Buffer,
  ): Promise<FileRecord> {
    if (bytes.length > MAX_UPLOAD_BYTES) {
      throw new PayloadTooLargeException('The upload is too big');
    }
    return this.jobs.run(() => this.save(scope, moduleId, projectId, bytes));
  }

  private async save(
    scope: Scope,
    moduleId: string,
    projectId: string | undefined,
    bytes: Buffer,
  ): Promise<FileRecord> {
    let variants: Awaited<ReturnType<typeof makeVariants>>;
    try {
      variants = await makeVariants(bytes);
    } catch (err) {
      if (err instanceof ImageRejected && err.reason === 'too_large') {
        throw new PayloadTooLargeException('The image has too many pixels');
      }
      if (err instanceof ImageRejected) {
        throw new UnsupportedMediaTypeException('Only PNG, JPEG and WebP images are accepted');
      }
      throw err;
    }

    const id = randomUUID();
    const dir = this.dir(scope.workspaceId, id);
    try {
      // Files first, row second: a row never points at files that are not there.
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const write = (name: string, data: Buffer) =>
        writeFile(join(dir, name), data, { mode: 0o600 });
      await Promise.all([
        write(`original.${variants.ext}`, bytes),
        write('thumb.webp', variants.thumb),
        write('reduced.webp', variants.reduced),
      ]);
      const [row] = await this.db.transaction((tx) =>
        tx
          .insert(files)
          .values(
            scopedInsert(scope, {
              id,
              projectId: projectId ?? null,
              moduleId,
              mime: variants.mime,
              bytes: bytes.length,
              sha256: createHash('sha256').update(bytes).digest('hex'),
              width: variants.width,
              height: variants.height,
            }),
          )
          .returning(),
      );
      return {
        id: row!.id,
        workspaceId: row!.workspaceId,
        projectId: row!.projectId,
        moduleId: row!.moduleId,
        mime: row!.mime,
        bytes: row!.bytes,
        sha256: row!.sha256,
        width: row!.width,
        height: row!.height,
      };
    } catch (err) {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
      throw err;
    }
  }

  /**
   * Visibility comes from the row's project (null is workspace-level, so every member sees it).
   * A file the caller cannot see is a 404, the same as one that does not exist.
   */
  async open(scope: Scope, fileId: string, size: FileSize): Promise<FileStream> {
    const [row] = await this.db
      .select()
      .from(files)
      .where(and(scoped(scope, files), eq(files.id, fileId)));
    if (!row) throw new NotFoundException('File not found');
    if (
      !this.registry.get(row.moduleId) ||
      !(await this.modules.isEnabled(scope.workspaceId, row.moduleId))
    ) {
      throw moduleOff(row.moduleId);
    }

    const name = size === 'original' ? `original.${extensionOf(row.mime)}` : `${size}.webp`;
    const path = join(this.dir(row.workspaceId, row.id), name);
    try {
      const { size: length } = await stat(path);
      return {
        stream: createReadStream(path),
        mime: size === 'original' ? row.mime : 'image/webp',
        length,
      };
    } catch {
      this.log.error(`File ${row.id} is on record but its ${size} copy cannot be read`);
      throw new NotFoundException('File not found');
    }
  }
}

function extensionOf(mime: string): string {
  return mime === 'image/jpeg' ? 'jpg' : mime === 'image/webp' ? 'webp' : 'png';
}
