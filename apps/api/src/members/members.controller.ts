import { ChangeRoleRequest, type MemberSummary } from '@briefroom/contracts';
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { fromNodeHeaders } from 'better-auth/node';
import type { IncomingHttpHeaders } from 'node:http';
import { RequireRole } from '../access/require-role.decorator.ts';
import type { Scope } from '../access/scope.ts';
import { CurrentScope, WorkspaceScopeGuard } from '../access/workspace-scope.guard.ts';
import { MembersService } from './members.service.ts';

interface HeaderCarrier {
  headers: IncomingHttpHeaders;
}

@UseGuards(WorkspaceScopeGuard)
@Controller('v1/workspaces/:workspaceId')
export class MembersController {
  constructor(private readonly members: MembersService) {}

  @Get('members')
  list(@CurrentScope() scope: Scope): Promise<MemberSummary[]> {
    return this.members.list(scope);
  }

  @RequireRole('admin')
  @Patch('members/:userId')
  changeRole(
    @CurrentScope() scope: Scope,
    @Req() req: HeaderCarrier,
    @Param('userId') userId: string,
    @Body() body: unknown,
  ): Promise<MemberSummary> {
    const parsed = ChangeRoleRequest.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.issues.map((i) => i.message).join('; '));
    }
    return this.members.changeRole(scope, fromNodeHeaders(req.headers), userId, parsed.data.role);
  }

  @Post('leave')
  @HttpCode(204)
  leave(@CurrentScope() scope: Scope, @Req() req: HeaderCarrier): Promise<void> {
    return this.members.leave(scope, fromNodeHeaders(req.headers));
  }
}
