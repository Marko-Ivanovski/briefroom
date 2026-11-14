import { readFileSync } from 'node:fs';
import type { VersionResponse } from '@briefroom/contracts';
import { Controller, Get } from '@nestjs/common';
import { AllowAnonymous } from '@thallesp/nestjs-better-auth';
import { InstallService } from '../install/install.service.ts';

const { version } = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
) as { version: string };

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
    return { api: '1', app: version, installId: (await this.installs.getRow()).id };
  }
}
