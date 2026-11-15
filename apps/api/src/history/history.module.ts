import { CORE_HISTORY } from '@briefroom/module-kit/core';
import { Global, Module } from '@nestjs/common';
import { HistoryController } from './history.controller.ts';
import { HistoryService } from './history.service.ts';

@Global()
@Module({
  controllers: [HistoryController],
  providers: [HistoryService, { provide: CORE_HISTORY, useExisting: HistoryService }],
  exports: [CORE_HISTORY],
})
export class HistoryModule {}
