import { provideModuleServices } from '@briefroom/module-kit';
import { Module } from '@nestjs/common';
import { FilesController } from './files.controller.ts';
import { GreetingController } from './greeting.controller.ts';
import { NotesController } from './notes.controller.ts';
import { NotesTools } from './notes.tools.ts';
import { PingJob } from './ping.job.ts';

@Module({
  controllers: [NotesController, GreetingController, FilesController],
  providers: [PingJob, NotesTools, ...provideModuleServices('testkit')],
})
export class TestkitModule {}
