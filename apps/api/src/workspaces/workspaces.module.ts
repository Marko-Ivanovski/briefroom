import { Module } from '@nestjs/common';
import { AccessModule } from '../access/access.module.ts';
import { MembersController } from '../members/members.controller.ts';
import { MembersService } from '../members/members.service.ts';
import { WorkspacesController } from './workspaces.controller.ts';
import { WorkspacesService } from './workspaces.service.ts';

// AccessModule is imported here, not in AppModule: Nest orders global guards by module distance, and
// this depth puts its guard after the Better Auth guard that puts the session on the request.
@Module({
  imports: [AccessModule],
  controllers: [WorkspacesController, MembersController],
  providers: [WorkspacesService, MembersService],
})
export class WorkspacesModule {}
