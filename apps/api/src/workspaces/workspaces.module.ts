import { Module } from '@nestjs/common';
import { MembersController } from '../members/members.controller.ts';
import { PasswordResetController } from '../members/password-reset.controller.ts';
import { PasswordResetLinks } from '../members/password-reset-links.service.ts';
import { PasswordResetService } from '../members/password-reset.service.ts';
import { MembersService } from '../members/members.service.ts';
import { ProjectsModule } from '../projects/projects.module.ts';
import { RevocationModule } from '../members/revocation.module.ts';
import { RateLimitModule } from '../rate-limit/rate-limit.ts';
import { TokensModule } from '../tokens/tokens.module.ts';
import { BookmarksController } from './bookmarks.controller.ts';
import { BookmarksService } from './bookmarks.service.ts';
import { MeController } from './me.controller.ts';
import { WorkspacesController } from './workspaces.controller.ts';
import { WorkspacesService } from './workspaces.service.ts';

@Module({
  imports: [ProjectsModule, RevocationModule, RateLimitModule, TokensModule],
  controllers: [
    MeController,
    BookmarksController,
    WorkspacesController,
    MembersController,
    PasswordResetController,
  ],
  providers: [
    WorkspacesService,
    BookmarksService,
    MembersService,
    PasswordResetService,
    PasswordResetLinks,
  ],
})
export class WorkspacesModule {}
