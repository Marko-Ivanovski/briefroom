import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ReadStream } from 'node:fs';
import { files, projects, scoped, scopedInsert, scopedProjects, type Db } from '@briefroom/db';
import {
  MAX_UPLOAD_BYTES,
  type FileRecord,
  type FileStore,
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
import { and, eq } from 'drizzle-orm';
import type { Scope } from '../access/scope.ts';
import { ENV, type Env } from '../config/env.ts';
import { DB } from '../database/database.module.ts';
import { ModuleRegistryService } from '../module-registry/module-registry.service.ts';
import { WorkspaceModulesService } from '../module-registry/workspace-modules.service.ts';
import { detectImage, ImageRejected, makeVariants } from './image.ts';

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
export class FilesService implements FileStore {
  private readonly log = new Logger('Files');

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

  async store(scope: Scope, input: FileStoreInput): Promise<FileRecord> {
    const { moduleId, projectId, bytes } = input;
    if (!this.registry.get(moduleId)) throw new BadRequestException('Unknown module');
    if (!(await this.modules.isEnabled(scope.workspaceId, moduleId))) throw moduleOff(moduleId);
    if (bytes.length > MAX_UPLOAD_BYTES)
      throw new PayloadTooLargeException('The upload is too big');
    if (projectId) {
      const [visible] = await this.db
        .select({ id: projects.id })
        .from(projects)
        .where(and(scopedProjects(scope), eq(projects.id, projectId)));
      if (!visible) throw new NotFoundException('Project not found');
    }

    let mime: string;
    let ext: string;
    let variants: Awaited<ReturnType<typeof makeVariants>>;
    try {
      ({ mime, ext } = await detectImage(bytes));
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
      await mkdir(dir, { recursive: true });
      await Promise.all([
        writeFile(join(dir, `original.${ext}`), bytes),
        writeFile(join(dir, 'thumb.webp'), variants.thumb),
        writeFile(join(dir, 'reduced.webp'), variants.reduced),
      ]);
      const [row] = await this.db.transaction((tx) =>
        tx
          .insert(files)
          .values(
            scopedInsert(scope, {
              id,
              projectId: projectId ?? null,
              moduleId,
              mime,
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
