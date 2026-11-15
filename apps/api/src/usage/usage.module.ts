import { CORE_USAGE } from '@briefroom/module-kit/core';
import { Global, Module } from '@nestjs/common';
import { UsageService } from './usage.service.ts';

@Global()
@Module({
  providers: [UsageService, { provide: CORE_USAGE, useExisting: UsageService }],
  exports: [UsageService, CORE_USAGE],
})
export class UsageModule {}
