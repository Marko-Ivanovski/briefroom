import { SetPermissionRequest, type MemberPermission } from '@briefroom/contracts';
import { BadRequestException, Body, Controller, Get, Param, Put } from '@nestjs/common';
import { RequireRole } from '../access/require-role.decorator.ts';
import type { Scope } from '../access/scope.ts';
import { CurrentScope } from '../access/workspace-scope.guard.ts';
import { MemberPermissionsService } from './member-permissions.service.ts';

@Controller('v1/workspaces/:workspaceId/members/:userId/permissions')
export class PermissionsController {
  constructor(private readonly permissions: MemberPermissionsService) {}

  @RequireRole('admin')
  @Get()
  view(@CurrentScope() scope: Scope, @Param('userId') userId: string): Promise<MemberPermission[]> {
    return this.permissions.view(scope, userId);
  }

  @RequireRole('admin')
  @Put()
  set(
    @CurrentScope() scope: Scope,
    @Param('userId') userId: string,
    @Body() body: unknown,
  ): Promise<MemberPermission> {
    const parsed = SetPermissionRequest.safeParse(body);
    if (!parsed.success) throw new BadRequestException('moduleId, key and granted are required');
    return this.permissions.set(scope, userId, parsed.data);
  }
}
