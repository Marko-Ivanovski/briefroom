import { Module } from '@nestjs/common';
import { ProjectMembersController } from './project-members.controller.ts';
import { ProjectMembersService } from './project-members.service.ts';
import { ProjectsController } from './projects.controller.ts';
import { ProjectsService } from './projects.service.ts';
import { SettingsService } from './settings.service.ts';

@Module({
  controllers: [ProjectsController, ProjectMembersController],
  providers: [ProjectsService, SettingsService, ProjectMembersService],
  exports: [ProjectsService, ProjectMembersService],
})
export class ProjectsModule {}
