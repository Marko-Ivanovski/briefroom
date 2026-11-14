import { EVENTS } from '@briefroom/module-kit';
import { Global, Module, type DynamicModule } from '@nestjs/common';
import { RevocationModule } from '../members/revocation.module.ts';
import { EventsController } from './events.controller.ts';
import { EventsDispatcher } from './events-dispatcher.ts';
import { EventsListener } from './events-listener.ts';
import { EventsService } from './events.service.ts';
import { StreamRegistry } from './stream-registry.ts';
import { StreamRevocation } from './stream-revocation.ts';

export type EventsMode = 'app' | 'worker';

@Global()
@Module({})
export class EventsModule {
  /** Both processes publish. Only the app holds the LISTEN connection and serves streams. */
  static register(mode: EventsMode): DynamicModule {
    const publisher = [EventsService, { provide: EVENTS, useExisting: EventsService }];
    if (mode === 'worker') {
      return { module: EventsModule, providers: publisher, exports: [EVENTS, EventsService] };
    }
    return {
      module: EventsModule,
      imports: [RevocationModule],
      controllers: [EventsController],
      providers: [...publisher, StreamRegistry, EventsDispatcher, EventsListener, StreamRevocation],
      exports: [EVENTS, EventsService, StreamRegistry],
    };
  }
}
