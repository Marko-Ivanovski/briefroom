import { CORE_FILE_STORE } from '@briefroom/module-kit/core';
import { Global, Module } from '@nestjs/common';
import { FilesController } from './files.controller.ts';
import { FilesService } from './files.service.ts';

@Global()
@Module({
  controllers: [FilesController],
  providers: [FilesService, { provide: CORE_FILE_STORE, useExisting: FilesService }],
  exports: [CORE_FILE_STORE],
})
export class FilesModule {}
