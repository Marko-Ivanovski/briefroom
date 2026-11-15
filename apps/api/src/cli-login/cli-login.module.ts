import { Module } from '@nestjs/common';
import { RateLimitModule } from '../rate-limit/rate-limit.ts';
import { TokensModule } from '../tokens/tokens.module.ts';
import { CliLoginController } from './cli-login.controller.ts';
import { CliLoginService } from './cli-login.service.ts';

@Module({
  imports: [TokensModule, RateLimitModule],
  controllers: [CliLoginController],
  providers: [CliLoginService],
})
export class CliLoginModule {}
