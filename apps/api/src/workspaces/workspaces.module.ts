import { Module } from '@nestjs/common';
import { AccessModule } from '../access/access.module.ts';
import { MembersController } from '../members/members.controller.ts';
import { PasswordResetController } from '../members/password-reset.controller.ts';
import { PasswordResetLinks } from '../members/password-reset-links.service.ts';
import { PasswordResetService } from '../members/password-reset.service.ts';
import { MembersService } from '../members/members.service.ts';
import { MeController } from './me.controller.ts';
import { WorkspacesController } from './workspaces.controller.ts';
import { WorkspacesService } from './workspaces.service.ts';

// AccessModule is imported here, not in AppModule: Nest orders global guards by module distance, and
// this depth puts its guard after the Better Auth guard that puts the session on the request.
@Module({
  imports: [AccessModule],
  controllers: [MeController, WorkspacesController, MembersController, PasswordResetController],
  providers: [WorkspacesService, MembersService, PasswordResetService, PasswordResetLinks],
})
export class WorkspacesModule {}
