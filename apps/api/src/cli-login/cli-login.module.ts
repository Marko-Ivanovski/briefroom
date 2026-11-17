import { Module } from '@nestjs/common';
import { RevocationModule } from '../members/revocation.module.ts';
import { RateLimitModule } from '../rate-limit/rate-limit.ts';
import { TokensModule } from '../tokens/tokens.module.ts';
import { CliLoginController } from './cli-login.controller.ts';
import { CliLoginService } from './cli-login.service.ts';

@Module({
  imports: [TokensModule, RateLimitModule, RevocationModule],
  controllers: [CliLoginController],
  providers: [CliLoginService],
})
export class CliLoginModule {}
