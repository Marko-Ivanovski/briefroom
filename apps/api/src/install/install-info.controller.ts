import type { InstallInfo } from '@briefroom/contracts';
import { Controller, ForbiddenException, Get } from '@nestjs/common';
import { CurrentUser, type CurrentUserData } from '../auth/current-user.decorator.ts';
import { TunnelState } from '../remote-access/tunnel-state.ts';
import { InstallService } from './install.service.ts';
import { ReachService } from './reach.service.ts';

export const CHANGE_COMMAND = 'npx briefroom init';

@Controller('v1/install')
export class InstallInfoController {
  constructor(
    private readonly installs: InstallService,
    private readonly reach: ReachService,
    private readonly tunnel: TunnelState,
  ) {}

  @Get()
  async info(@CurrentUser() user: CurrentUserData): Promise<InstallInfo> {
    if (!(await this.installs.isInstallOwner(user.id))) {
      throw new ForbiddenException('Only the install owner can see the install settings');
    }
    return {
      installId: (await this.installs.getRow()).id,
      publicUrl: this.tunnel.publicUrl(),
      reach: this.reach.current(),
      changeCommand: CHANGE_COMMAND,
    };
  }
}
