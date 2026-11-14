import { Module } from '@nestjs/common';
import { FilesController } from './files.controller.ts';
import { GreetingController } from './greeting.controller.ts';
import { NotesController } from './notes.controller.ts';

@Module({ controllers: [NotesController, GreetingController, FilesController] })
export class TestkitModule {}
