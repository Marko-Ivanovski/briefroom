import { Module } from '@nestjs/common';
import { MembersController } from '../members/members.controller.ts';
import { MembersService } from '../members/members.service.ts';
import { WorkspacesController } from './workspaces.controller.ts';
import { WorkspacesService } from './workspaces.service.ts';

@Module({
  controllers: [WorkspacesController, MembersController],
  providers: [WorkspacesService, MembersService],
})
export class WorkspacesModule {}
