import { readFileSync } from 'node:fs';
import type { VersionResponse } from '@briefroom/contracts';
import { Controller, Get } from '@nestjs/common';

const { version } = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
) as { version: string };

@Controller()
export class SystemController {
  @Get('health')
  health(): { ok: true } {
    return { ok: true };
  }

  @Get('version')
  version(): VersionResponse {
    return { api: '1', app: version, installId: null };
  }
}
