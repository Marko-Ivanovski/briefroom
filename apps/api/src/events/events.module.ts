import { EVENTS } from '@briefroom/module-kit';
import {
  Global,
  Module,
  RequestMethod,
  type DynamicModule,
  type MiddlewareConsumer,
  type NestModule,
} from '@nestjs/common';
import { RevocationModule } from '../members/revocation.module.ts';
import { EventsController } from './events.controller.ts';
import { EventsDispatcher } from './events-dispatcher.ts';
import { EventsListener } from './events-listener.ts';
import { EventsService } from './events.service.ts';
import { StreamEpochMiddleware } from './stream-epoch.middleware.ts';
import { StreamRegistry } from './stream-registry.ts';
import { StreamRevocation } from './stream-revocation.ts';

/** Applies the epoch middleware to the stream route. Only the app mode imports it. */
@Module({})
class EventsRoutesModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(StreamEpochMiddleware).forRoutes({
      path: 'v1/workspaces/:workspaceId/events',
      method: RequestMethod.GET,
    });
  }
}

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
      imports: [RevocationModule, EventsRoutesModule],
      controllers: [EventsController],
      providers: [...publisher, StreamRegistry, EventsDispatcher, EventsListener, StreamRevocation],
      exports: [EVENTS, EventsService, StreamRegistry],
    };
  }
}
