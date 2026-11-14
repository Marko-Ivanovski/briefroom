import { AddProjectMemberInput, type ProjectMemberSummary } from '@briefroom/contracts';
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
} from '@nestjs/common';
import { RequireRole } from '../access/require-role.decorator.ts';
import type { Scope } from '../access/scope.ts';
import { CurrentScope } from '../access/workspace-scope.guard.ts';
import { ProjectMembersService } from './project-members.service.ts';

@Controller('v1/workspaces/:workspaceId/projects/:projectId/members')
export class ProjectMembersController {
  constructor(private readonly members: ProjectMembersService) {}

  @Get()
  list(
    @CurrentScope() scope: Scope,
    @Param('projectId') projectId: string,
  ): Promise<ProjectMemberSummary[]> {
    return this.members.list(scope, projectId);
  }

  @RequireRole('admin')
  @Post()
  add(
    @CurrentScope() scope: Scope,
    @Param('projectId') projectId: string,
    @Body() body: unknown,
  ): Promise<ProjectMemberSummary> {
    const parsed = AddProjectMemberInput.safeParse(body);
    if (!parsed.success) throw new BadRequestException('userId is required');
    return this.members.add(scope, projectId, parsed.data.userId);
  }

  @Post('leave')
  @HttpCode(204)
  leave(@CurrentScope() scope: Scope, @Param('projectId') projectId: string): Promise<void> {
    return this.members.leave(scope, projectId);
  }

  @RequireRole('admin')
  @Delete(':userId')
  @HttpCode(204)
  remove(
    @CurrentScope() scope: Scope,
    @Param('projectId') projectId: string,
    @Param('userId') userId: string,
  ): Promise<void> {
    return this.members.remove(scope, projectId, userId);
  }
}
