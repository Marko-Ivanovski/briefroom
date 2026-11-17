import type { InstallInfo } from '@briefroom/contracts';
import { Controller, ForbiddenException, Get, Inject } from '@nestjs/common';
import { CurrentUser, type CurrentUserData } from '../auth/current-user.decorator.ts';
import { ENV, type Env } from '../config/env.ts';
import { InstallService } from './install.service.ts';
import { ReachService } from './reach.service.ts';

export const CHANGE_COMMAND = 'npx briefroom init';

@Controller('v1/install')
export class InstallInfoController {
  constructor(
    private readonly installs: InstallService,
    private readonly reach: ReachService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  @Get()
  async info(@CurrentUser() user: CurrentUserData): Promise<InstallInfo> {
    if (!(await this.installs.isInstallOwner(user.id))) {
      throw new ForbiddenException('Only the install owner can see the install settings');
    }
    return {
      installId: (await this.installs.getRow()).id,
      publicUrl: this.env.publicUrl,
      reach: this.reach.current(),
      changeCommand: CHANGE_COMMAND,
    };
  }
}
