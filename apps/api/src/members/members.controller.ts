import {
  ChangeRoleRequest,
  type MemberSummary,
  type ResetLinkResponse,
} from '@briefroom/contracts';
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
} from '@nestjs/common';
import { fromNodeHeaders } from 'better-auth/node';
import type { IncomingHttpHeaders } from 'node:http';
import { RequireRole } from '../access/require-role.decorator.ts';
import type { Scope } from '../access/scope.ts';
import { CurrentScope } from '../access/workspace-scope.guard.ts';
import { MembersService } from './members.service.ts';
import { PasswordResetService } from './password-reset.service.ts';

interface HeaderCarrier {
  headers: IncomingHttpHeaders;
}

@Controller('v1/workspaces/:workspaceId')
export class MembersController {
  constructor(
    private readonly members: MembersService,
    private readonly resets: PasswordResetService,
  ) {}

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

  @RequireRole('admin')
  @Post('members/:userId/reset-link')
  createResetLink(
    @CurrentScope() scope: Scope,
    @Param('userId') userId: string,
  ): Promise<ResetLinkResponse> {
    return this.resets.createForMember(scope, userId);
  }

  @Post('leave')
  @HttpCode(204)
  leave(@CurrentScope() scope: Scope, @Req() req: HeaderCarrier): Promise<void> {
    return this.members.leave(scope, fromNodeHeaders(req.headers));
  }
}
