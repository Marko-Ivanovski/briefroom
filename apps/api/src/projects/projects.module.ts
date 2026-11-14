import { Module } from '@nestjs/common';
import { ProjectsController } from './projects.controller.ts';
import { ProjectsService } from './projects.service.ts';
import { SettingsService } from './settings.service.ts';

@Module({
  controllers: [ProjectsController],
  providers: [ProjectsService, SettingsService],
  exports: [ProjectsService],
})
export class ProjectsModule {}
