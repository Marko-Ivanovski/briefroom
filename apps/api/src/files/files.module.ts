import { FILE_STORE } from '@briefroom/module-kit';
import { Global, Module } from '@nestjs/common';
import { FilesController } from './files.controller.ts';
import { FilesService } from './files.service.ts';

@Global()
@Module({
  controllers: [FilesController],
  providers: [FilesService, { provide: FILE_STORE, useExisting: FilesService }],
  exports: [FILE_STORE],
})
export class FilesModule {}
