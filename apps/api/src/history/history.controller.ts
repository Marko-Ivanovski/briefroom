import type { HistoryEntry } from '@briefroom/contracts';
import { ConflictException, Controller, Get, NotFoundException, Param } from '@nestjs/common';
import { z } from 'zod';
import type { Scope } from '../access/scope.ts';
import { CurrentScope } from '../access/workspace-scope.guard.ts';
import { WorkspaceModulesService } from '../module-registry/workspace-modules.service.ts';
import { HistoryService } from './history.service.ts';

@Controller('v1/workspaces/:workspaceId/history')
export class HistoryController {
  constructor(
    private readonly history: HistoryService,
    private readonly modules: WorkspaceModulesService,
  ) {}

  @Get(':table/:recordId')
  async entries(
    @CurrentScope() scope: Scope,
    @Param('table') table: string,
    @Param('recordId') recordId: string,
  ): Promise<HistoryEntry[]> {
    const source = this.history.source(table);
    if (!source || !z.uuid().safeParse(recordId).success) {
      throw new NotFoundException('Record not found');
    }
    if (source.moduleId && !(await this.modules.isEnabled(scope.workspaceId, source.moduleId))) {
      throw new ConflictException({
        code: 'module_off',
        moduleId: source.moduleId,
        message: 'This module is switched off in this workspace',
      });
    }
    return this.history.entries(scope, table, recordId);
  }
}
