import { RemoteAccessUpdate, type RemoteAccessSettings } from '@briefroom/contracts';
import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Put,
} from '@nestjs/common';
import { CurrentUser, type CurrentUserData } from '../auth/current-user.decorator.ts';
import { InstallService } from '../install/install.service.ts';
import { RemoteAccessService } from './remote-access.service.ts';

@Controller('v1/install/remote-access')
export class RemoteAccessController {
  constructor(
    private readonly installs: InstallService,
    private readonly remote: RemoteAccessService,
  ) {}

  @Get()
  async settings(@CurrentUser() user: CurrentUserData): Promise<RemoteAccessSettings> {
    await this.assertInstallOwner(user.id);
    return this.remote.settings();
  }

  @Put()
  async update(
    @CurrentUser() user: CurrentUserData,
    @Body() body: unknown,
  ): Promise<RemoteAccessSettings> {
    await this.assertInstallOwner(user.id);
    const parsed = RemoteAccessUpdate.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(
        parsed.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '),
      );
    }
    return this.remote.update({ userId: user.id, via: 'web' }, parsed.data);
  }

  private async assertInstallOwner(userId: string): Promise<void> {
    if (!(await this.installs.isInstallOwner(userId))) {
      throw new ForbiddenException('Only the install owner can change remote access');
    }
  }
}
