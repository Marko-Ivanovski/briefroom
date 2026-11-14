import {
  BadRequestException,
  Controller,
  Get,
  Header,
  NotFoundException,
  Param,
  Query,
  StreamableFile,
} from '@nestjs/common';
import { z } from 'zod';
import type { Scope } from '../access/scope.ts';
import { CurrentScope } from '../access/workspace-scope.guard.ts';
import { FilesService } from './files.service.ts';

const Size = z.enum(['thumb', 'reduced', 'original']).default('original');

@Controller('v1/workspaces/:workspaceId/files')
export class FilesController {
  constructor(private readonly files: FilesService) {}

  @Get(':fileId')
  @Header('X-Content-Type-Options', 'nosniff')
  @Header('Cache-Control', 'private, max-age=86400')
  @Header('Content-Security-Policy', "default-src 'none'; sandbox")
  @Header('Cross-Origin-Resource-Policy', 'same-origin')
  async read(
    @CurrentScope() scope: Scope,
    @Param('fileId') fileId: string,
    @Query('size') size: unknown,
  ): Promise<StreamableFile> {
    if (!z.uuid().safeParse(fileId).success) throw new NotFoundException('File not found');
    const parsed = Size.safeParse(size);
    if (!parsed.success) throw new BadRequestException('size is thumb, reduced or original');
    const file = await this.files.open(scope, fileId, parsed.data);
    return new StreamableFile(file.stream, {
      type: file.mime,
      disposition: 'inline',
      length: file.length,
    });
  }
}
