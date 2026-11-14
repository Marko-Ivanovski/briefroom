import type { ServerResponse } from 'node:http';
import { SetupRequest, type SetupResponse, type SetupStatus } from '@briefroom/contracts';
import { BadRequestException, Body, Controller, Get, Post, Res } from '@nestjs/common';
import { AllowAnonymous } from '@thallesp/nestjs-better-auth';
import { SetupService } from './setup.service.ts';

@AllowAnonymous()
@Controller('v1/setup')
export class InstallController {
  constructor(private readonly setup: SetupService) {}

  @Get()
  async status(): Promise<SetupStatus> {
    return { needsSetup: await this.setup.needsSetup() };
  }

  @Post()
  async run(
    @Body() body: unknown,
    @Res({ passthrough: true }) res: ServerResponse,
  ): Promise<SetupResponse> {
    const parsed = SetupRequest.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.issues.map((i) => i.message).join('; '));
    }
    const { cookies, userId, workspaceId } = await this.setup.setup(parsed.data);
    res.setHeader('set-cookie', cookies);
    return { userId, workspaceId };
  }
}
