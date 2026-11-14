import { Module } from '@nestjs/common';
import { MembersController } from '../members/members.controller.ts';
import { PasswordResetController } from '../members/password-reset.controller.ts';
import { PasswordResetLinks } from '../members/password-reset-links.service.ts';
import { PasswordResetService } from '../members/password-reset.service.ts';
import { MembersService } from '../members/members.service.ts';
import { ProjectsModule } from '../projects/projects.module.ts';
import { RevocationModule } from '../members/revocation.module.ts';
import { MeController } from './me.controller.ts';
import { WorkspacesController } from './workspaces.controller.ts';
import { WorkspacesService } from './workspaces.service.ts';

@Module({
  imports: [ProjectsModule, RevocationModule],
  controllers: [MeController, WorkspacesController, MembersController, PasswordResetController],
  providers: [WorkspacesService, MembersService, PasswordResetService, PasswordResetLinks],
})
export class WorkspacesModule {}
