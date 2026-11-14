import { Module } from '@nestjs/common';
import { RateLimitModule } from '../rate-limit/rate-limit.ts';
import { InvitesController, JoinController } from './invites.controller.ts';
import { InvitesService } from './invites.service.ts';

@Module({
  imports: [RateLimitModule],
  controllers: [InvitesController, JoinController],
  providers: [InvitesService],
  exports: [InvitesService],
})
export class InvitesModule {}
