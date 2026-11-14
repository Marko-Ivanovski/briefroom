import { Module } from '@nestjs/common';
import { NotesController } from './notes.controller.ts';

@Module({ controllers: [NotesController] })
export class TestkitModule {}
