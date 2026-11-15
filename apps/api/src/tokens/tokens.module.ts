import { Module } from '@nestjs/common';
import { RevocationModule } from '../members/revocation.module.ts';
import { TokensController } from './tokens.controller.ts';
import { TokensService } from './tokens.service.ts';

@Module({
  imports: [RevocationModule],
  controllers: [TokensController],
  providers: [TokensService],
  exports: [TokensService],
})
export class TokensModule {}
