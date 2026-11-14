import type { MeResponse } from '@briefroom/contracts';
import { Controller, Get } from '@nestjs/common';
import { CurrentUser, type CurrentUserData } from '../auth/current-user.decorator.ts';
import { InstallService } from '../install/install.service.ts';

@Controller('v1/me')
export class MeController {
  constructor(private readonly installs: InstallService) {}

  @Get()
  async me(@CurrentUser() user: CurrentUserData): Promise<MeResponse> {
    return {
      userId: user.id,
      name: user.name,
      email: user.email,
      isInstallOwner: await this.installs.isInstallOwner(user.id),
    };
  }
}
