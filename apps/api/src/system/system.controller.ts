import type { VersionResponse } from '@briefroom/contracts';
import { Controller, Get } from '@nestjs/common';
import { AllowAnonymous } from '@thallesp/nestjs-better-auth';
import { InstallService } from '../install/install.service.ts';
import { APP_VERSION } from './app-version.ts';

@AllowAnonymous()
@Controller()
export class SystemController {
  constructor(private readonly installs: InstallService) {}

  @Get('health')
  health(): { ok: true } {
    return { ok: true };
  }

  @Get('version')
  async version(): Promise<VersionResponse> {
    return { api: '1', app: APP_VERSION, installId: (await this.installs.getRow()).id };
  }
}
