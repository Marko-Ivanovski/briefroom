import { Module } from '@nestjs/common';
import { GreetingController } from './greeting.controller.ts';
import { NotesController } from './notes.controller.ts';

@Module({ controllers: [NotesController, GreetingController] })
export class TestkitModule {}
