import { HISTORY } from '@briefroom/module-kit';
import { Global, Module } from '@nestjs/common';
import { HistoryController } from './history.controller.ts';
import { HistoryService } from './history.service.ts';

@Global()
@Module({
  controllers: [HistoryController],
  providers: [HistoryService, { provide: HISTORY, useExisting: HistoryService }],
  exports: [HISTORY],
})
export class HistoryModule {}
