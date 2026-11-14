import {
  CurrentScope,
  FILE_STORE,
  hasPermission,
  ModuleController,
  UploadBody,
  type FileRecord,
  type FileStore,
  type Scope,
  type UploadReader,
} from '@briefroom/module-kit';
import {
  BadRequestException,
  Delete,
  ForbiddenException,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { z } from 'zod';

@ModuleController('testkit', 'files')
export class FilesController {
  constructor(@Inject(FILE_STORE) private readonly fileStore: FileStore) {}

  @Post()
  upload(
    @CurrentScope() scope: Scope,
    @UploadBody() bytes: UploadReader,
    @Query('projectId') projectId?: string,
  ): Promise<FileRecord> {
    if (!hasPermission(scope, 'testkit', 'write-notes')) throw new ForbiddenException();
    const project = projectId === undefined ? undefined : z.uuid().safeParse(projectId);
    if (project && !project.success) throw new BadRequestException('projectId must be a uuid');
    return this.fileStore.store(scope, { projectId: project?.data, bytes });
  }

  @Delete(':fileId')
  @HttpCode(204)
  async remove(@CurrentScope() scope: Scope, @Param('fileId') fileId: string): Promise<void> {
    if (!hasPermission(scope, 'testkit', 'write-notes')) throw new ForbiddenException();
    if (!z.uuid().safeParse(fileId).success) throw new NotFoundException('File not found');
    await this.fileStore.remove(scope, fileId);
  }
}
