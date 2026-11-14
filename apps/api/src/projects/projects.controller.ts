import {
  ProjectInput,
  ProjectPatch,
  WorkspaceSettings,
  type ProjectDetail,
  type ProjectSummary,
} from '@briefroom/contracts';
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import type { z } from 'zod';
import { RequireRole } from '../access/require-role.decorator.ts';
import type { Scope } from '../access/scope.ts';
import { CurrentScope } from '../access/workspace-scope.guard.ts';
import { ProjectsService } from './projects.service.ts';
import { SettingsService } from './settings.service.ts';

function parse<T extends z.ZodType>(schema: T, body: unknown): z.output<T> {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new BadRequestException(
      parsed.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '),
    );
  }
  return parsed.data;
}

@Controller('v1/workspaces/:workspaceId')
export class ProjectsController {
  constructor(
    private readonly projects: ProjectsService,
    private readonly settings: SettingsService,
  ) {}

  @Get('projects')
  list(@CurrentScope() scope: Scope): Promise<ProjectSummary[]> {
    return this.projects.list(scope);
  }

  // Open to every member: the service allows non-admins only when the workspace setting is on.
  @Post('projects')
  create(@CurrentScope() scope: Scope, @Body() body: unknown): Promise<ProjectDetail> {
    return this.projects.create(scope, parse(ProjectInput, body));
  }

  @Get('projects/:projectId')
  get(@CurrentScope() scope: Scope, @Param('projectId') projectId: string): Promise<ProjectDetail> {
    return this.projects.get(scope, projectId);
  }

  @RequireRole('admin')
  @Patch('projects/:projectId')
  update(
    @CurrentScope() scope: Scope,
    @Param('projectId') projectId: string,
    @Body() body: unknown,
  ): Promise<ProjectDetail> {
    return this.projects.update(scope, projectId, parse(ProjectPatch, body));
  }

  @RequireRole('admin')
  @Delete('projects/:projectId')
  @HttpCode(204)
  remove(@CurrentScope() scope: Scope, @Param('projectId') projectId: string): Promise<void> {
    return this.projects.remove(scope, projectId);
  }

  @Get('settings')
  getSettings(@CurrentScope() scope: Scope): Promise<WorkspaceSettings> {
    return this.settings.get(scope);
  }

  @RequireRole('admin')
  @Patch('settings')
  updateSettings(@CurrentScope() scope: Scope, @Body() body: unknown): Promise<WorkspaceSettings> {
    return this.settings.update(scope, parse(WorkspaceSettings, body));
  }
}
