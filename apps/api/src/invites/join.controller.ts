import type { ServerResponse } from 'node:http';
import {
  JoinSignUp,
  type JoinLookup,
  type JoinRequestSummary,
  type JoinResult,
} from '@briefroom/contracts';
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Res,
} from '@nestjs/common';
import { AllowAnonymous } from '@thallesp/nestjs-better-auth';
import { RequireRole } from '../access/require-role.decorator.ts';
import type { Scope } from '../access/scope.ts';
import { CurrentScope } from '../access/workspace-scope.guard.ts';
import { CurrentUser, type CurrentUserData } from '../auth/current-user.decorator.ts';
import { RateLimit } from '../rate-limit/rate-limit.ts';
import { InvitesService } from './invites.service.ts';
import { JoinService } from './join.service.ts';

@Controller('v1/join')
export class JoinController {
  constructor(
    private readonly invites: InvitesService,
    private readonly join: JoinService,
  ) {}

  @AllowAnonymous()
  @RateLimit()
  @Get(':token')
  lookup(@Param('token') token: string): Promise<JoinLookup> {
    return this.invites.lookup(token);
  }

  @AllowAnonymous()
  @RateLimit()
  @Post(':token/sign-up')
  async signUp(
    @Param('token') token: string,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: ServerResponse,
  ): Promise<JoinResult> {
    const parsed = JoinSignUp.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(
        parsed.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '),
      );
    }
    const { result, cookies } = await this.join.signUp(token, parsed.data);
    res.setHeader('set-cookie', cookies);
    return result;
  }

  @RateLimit()
  @Post(':token/accept')
  @HttpCode(200)
  accept(@Param('token') token: string, @CurrentUser() user: CurrentUserData): Promise<JoinResult> {
    return this.join.accept(token, user.id);
  }
}

@Controller('v1/workspaces/:workspaceId/join-requests')
export class JoinRequestsController {
  constructor(private readonly join: JoinService) {}

  @RequireRole('admin')
  @Get()
  list(@CurrentScope() scope: Scope): Promise<JoinRequestSummary[]> {
    return this.join.listRequests(scope);
  }

  @RequireRole('admin')
  @Post(':id/approve')
  @HttpCode(200)
  approve(@CurrentScope() scope: Scope, @Param('id') id: string): Promise<JoinResult> {
    return this.join.approve(scope, id);
  }

  @RequireRole('admin')
  @Post(':id/decline')
  @HttpCode(204)
  decline(@CurrentScope() scope: Scope, @Param('id') id: string): Promise<void> {
    return this.join.decline(scope, id);
  }
}
