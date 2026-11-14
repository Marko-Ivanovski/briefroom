import { UpdateModuleRequest, type ModuleSummary } from '@briefroom/contracts';
import { BadRequestException, Body, Controller, Get, Param, Put } from '@nestjs/common';
import { RequireRole } from '../access/require-role.decorator.ts';
import type { Scope } from '../access/scope.ts';
import { CurrentScope } from '../access/workspace-scope.guard.ts';
import { WorkspaceModulesService } from './workspace-modules.service.ts';

@Controller('v1/workspaces/:workspaceId/modules')
export class ModulesController {
  constructor(private readonly modules: WorkspaceModulesService) {}

  @Get()
  list(@CurrentScope() scope: Scope): Promise<ModuleSummary[]> {
    return this.modules.list(scope.workspaceId);
  }

  @RequireRole('admin')
  @Put(':moduleId')
  update(
    @CurrentScope() scope: Scope,
    @Param('moduleId') moduleId: string,
    @Body() body: unknown,
  ): Promise<ModuleSummary> {
    const parsed = UpdateModuleRequest.safeParse(body);
    if (!parsed.success) throw new BadRequestException('enabled or settings is required');
    return this.modules.update(scope, moduleId, parsed.data);
  }
}
