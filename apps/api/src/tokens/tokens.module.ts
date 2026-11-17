import { Module } from '@nestjs/common';
import { RevocationModule } from '../members/revocation.module.ts';
import { RateLimitModule } from '../rate-limit/rate-limit.ts';
import { TokensController } from './tokens.controller.ts';
import { TokensSelfController } from './tokens-self.controller.ts';
import { TokensService } from './tokens.service.ts';

@Module({
  imports: [RevocationModule, RateLimitModule],
  controllers: [TokensController, TokensSelfController],
  providers: [TokensService],
  exports: [TokensService],
})
export class TokensModule {}
