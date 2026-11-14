import {
  CurrentScope,
  FILE_STORE,
  hasPermission,
  ModuleController,
  UploadBytes,
  type FileRecord,
  type FileStore,
  type Scope,
} from '@briefroom/module-kit';
import { BadRequestException, ForbiddenException, Inject, Post, Query } from '@nestjs/common';
import { z } from 'zod';

@ModuleController('testkit', 'files')
export class FilesController {
  constructor(@Inject(FILE_STORE) private readonly fileStore: FileStore) {}

  @Post()
  upload(
    @CurrentScope() scope: Scope,
    @UploadBytes() bytes: Buffer,
    @Query('projectId') projectId?: string,
  ): Promise<FileRecord> {
    if (!hasPermission(scope, 'testkit', 'write-notes')) throw new ForbiddenException();
    const project = projectId === undefined ? undefined : z.uuid().safeParse(projectId);
    if (project && !project.success) throw new BadRequestException('projectId must be a uuid');
    return this.fileStore.store(scope, {
      moduleId: 'testkit',
      projectId: project?.data,
      bytes,
    });
  }
}
