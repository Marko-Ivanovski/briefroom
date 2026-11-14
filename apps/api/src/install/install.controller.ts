import type { ServerResponse } from 'node:http';
import {
  SetupRequest,
  type AvailableModule,
  type SetupResponse,
  type SetupStatus,
} from '@briefroom/contracts';
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  GoneException,
  Post,
  Res,
} from '@nestjs/common';
import { AllowAnonymous } from '@thallesp/nestjs-better-auth';
import { ModuleRegistryService } from '../module-registry/module-registry.service.ts';
import { WorkspaceModulesService } from '../module-registry/workspace-modules.service.ts';
import { SetupService } from './setup.service.ts';

@AllowAnonymous()
@Controller('v1/setup')
export class InstallController {
  constructor(
    private readonly setup: SetupService,
    private readonly registry: ModuleRegistryService,
    private readonly modules: WorkspaceModulesService,
  ) {}

  @Get()
  async status(): Promise<SetupStatus> {
    return { needsSetup: await this.setup.needsSetup() };
  }

  // Only the person running first-run setup needs this list, so it closes with setup like POST does.
  @Get('modules')
  async modulesToChoose(): Promise<AvailableModule[]> {
    if (!(await this.setup.needsSetup())) throw new GoneException('Setup is already done');
    return this.registry
      .list()
      .map(({ manifest: m }) => ({ id: m.id, name: m.name, description: m.description }));
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
    this.modules.validateStarting(parsed.data.modules);
    const { cookies, userId, workspaceId } = await this.setup.setup(parsed.data);
    res.setHeader('set-cookie', cookies);
    return { userId, workspaceId };
  }
}
