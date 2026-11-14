import { CreateWorkspaceRequest, type WorkspaceSummary } from '@briefroom/contracts';
import { BadRequestException, Body, Controller, Get, Post } from '@nestjs/common';
import { CurrentUser, type CurrentUserData } from '../auth/current-user.decorator.ts';
import { WorkspacesService } from './workspaces.service.ts';

@Controller('v1/workspaces')
export class WorkspacesController {
  constructor(private readonly workspaces: WorkspacesService) {}

  @Get()
  list(@CurrentUser() user: CurrentUserData): Promise<WorkspaceSummary[]> {
    return this.workspaces.listFor(user.id);
  }

  @Post()
  create(@CurrentUser() user: CurrentUserData, @Body() body: unknown): Promise<WorkspaceSummary> {
    const parsed = CreateWorkspaceRequest.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.issues.map((i) => i.message).join('; '));
    }
    return this.workspaces.create(user.id, parsed.data.name, parsed.data.modules);
  }
}
