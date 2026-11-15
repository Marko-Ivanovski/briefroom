import {
  Controller,
  Delete,
  HttpCode,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { AllowAnonymous } from '@thallesp/nestjs-better-auth';
import { McpTokenGuard } from '../mcp/mcp-token.guard.ts';
import { TokensService } from './tokens.service.ts';

/**
 * How `briefroom disconnect` revokes its own token without a session. AllowAnonymous takes the
 * route out of the session guard, so a cookie is never read: only the Bearer token decides, and
 * the token being deleted is the one that authenticated the call.
 */
@AllowAnonymous()
@UseGuards(McpTokenGuard)
@Controller('v1/tokens')
export class TokensSelfController {
  constructor(private readonly tokens: TokensService) {}

  @Delete('self')
  @HttpCode(204)
  async removeSelf(@Req() req: { tokenId?: string }): Promise<void> {
    if (!req.tokenId) throw new UnauthorizedException();
    await this.tokens.removeById(req.tokenId);
  }
}
