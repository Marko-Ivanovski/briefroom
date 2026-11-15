import { Module } from '@nestjs/common';
import { RevocationModule } from '../members/revocation.module.ts';
import { RateLimitModule } from '../rate-limit/rate-limit.ts';
import { ProjectsModule } from '../projects/projects.module.ts';
import { InvitesController } from './invites.controller.ts';
import { InvitesService } from './invites.service.ts';
import { JoinController, JoinRequestsController } from './join.controller.ts';
import { JoinService } from './join.service.ts';

@Module({
  imports: [RateLimitModule, ProjectsModule, RevocationModule],
  controllers: [InvitesController, JoinController, JoinRequestsController],
  providers: [InvitesService, JoinService],
  exports: [InvitesService],
})
export class InvitesModule {}
