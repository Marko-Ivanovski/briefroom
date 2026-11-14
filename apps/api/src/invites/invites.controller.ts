import {
  InviteCreate,
  type InviteCreated,
  type InviteSummary,
  type JoinLookup,
} from '@briefroom/contracts';
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
import { AllowAnonymous } from '@thallesp/nestjs-better-auth';
import { RequireRole } from '../access/require-role.decorator.ts';
import type { Scope } from '../access/scope.ts';
import { CurrentScope } from '../access/workspace-scope.guard.ts';
import { RateLimit } from '../rate-limit/rate-limit.ts';
import { InvitesService } from './invites.service.ts';

@Controller('v1/workspaces/:workspaceId/invites')
export class InvitesController {
  constructor(private readonly invites: InvitesService) {}

  @RequireRole('admin')
  @Post()
  create(@CurrentScope() scope: Scope, @Body() body: unknown): Promise<InviteCreated> {
    const parsed = InviteCreate.safeParse(body ?? {});
    if (!parsed.success) {
      throw new BadRequestException(
        parsed.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '),
      );
    }
    return this.invites.create(scope, parsed.data);
  }

  @RequireRole('admin')
  @Get()
  list(@CurrentScope() scope: Scope): Promise<InviteSummary[]> {
    return this.invites.list(scope);
  }

  @RequireRole('admin')
  @Delete(':id')
  @HttpCode(204)
  revoke(@CurrentScope() scope: Scope, @Param('id') id: string): Promise<void> {
    return this.invites.revoke(scope, id);
  }

  @RequireRole('admin')
  @Post(':id/regenerate')
  regenerate(@CurrentScope() scope: Scope, @Param('id') id: string): Promise<InviteCreated> {
    return this.invites.regenerate(scope, id);
  }
}

@Controller('v1/join')
export class JoinController {
  constructor(private readonly invites: InvitesService) {}

  @AllowAnonymous()
  @RateLimit()
  @Get(':token')
  lookup(@Param('token') token: string): Promise<JoinLookup> {
    return this.invites.lookup(token);
  }
}
