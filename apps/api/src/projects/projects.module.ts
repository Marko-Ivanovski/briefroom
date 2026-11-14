import { Module } from '@nestjs/common';
import { RevocationModule } from '../members/revocation.module.ts';
import { ChecklistService } from './checklist.service.ts';
import { ProjectMembersController } from './project-members.controller.ts';
import { ProjectMembersService } from './project-members.service.ts';
import { ProjectsController } from './projects.controller.ts';
import { ProjectsService } from './projects.service.ts';
import { SettingsService } from './settings.service.ts';

@Module({
  imports: [RevocationModule],
  controllers: [ProjectsController, ProjectMembersController],
  providers: [ProjectsService, SettingsService, ProjectMembersService, ChecklistService],
  exports: [ProjectsService, ProjectMembersService],
})
export class ProjectsModule {}
