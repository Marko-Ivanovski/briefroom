import { Global, Module } from '@nestjs/common';
import { InstallInfoController } from './install-info.controller.ts';
import { InstallController } from './install.controller.ts';
import { InstallService } from './install.service.ts';
import { ReachService } from './reach.service.ts';
import { SetupService } from './setup.service.ts';

@Global()
@Module({
  controllers: [InstallController, InstallInfoController],
  providers: [InstallService, ReachService, SetupService],
  exports: [InstallService, ReachService],
})
export class InstallModule {}
