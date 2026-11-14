import { Global, Module } from '@nestjs/common';
import { InstallController } from './install.controller.ts';
import { InstallService } from './install.service.ts';
import { SetupService } from './setup.service.ts';

@Global()
@Module({
  controllers: [InstallController],
  providers: [InstallService, SetupService],
  exports: [InstallService],
})
export class InstallModule {}
