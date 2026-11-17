import { TokenCreate, type TokenCreated, type TokenSummary } from '@briefroom/contracts';
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Req,
} from '@nestjs/common';
import type { Scope } from '../access/scope.ts';
import { CurrentScope } from '../access/workspace-scope.guard.ts';
import { TokensService } from './tokens.service.ts';

@Controller('v1/workspaces/:workspaceId/tokens')
export class TokensController {
  constructor(private readonly tokens: TokensService) {}

  @Get()
  list(@CurrentScope() scope: Scope): Promise<TokenSummary[]> {
    return this.tokens.list(scope);
  }

  @Post()
  async create(
    @CurrentScope() scope: Scope,
    @Req() req: { session?: { session?: { id: string } } | null },
    @Body() body: unknown,
  ): Promise<TokenCreated> {
    const parsed = TokenCreate.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        code: 'invalid_token_name',
        message: 'A token needs a name of 1 to 80 characters.',
      });
    }
    const { id, token } = await this.tokens.create(
      scope,
      parsed.data.name,
      req.session?.session?.id ?? '',
    );
    return { id, name: parsed.data.name, token };
  }

  @Delete(':id')
  @HttpCode(204)
  remove(@CurrentScope() scope: Scope, @Param('id') id: string): Promise<void> {
    return this.tokens.remove(scope, id);
  }
}
