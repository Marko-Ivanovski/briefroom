import {
  Inject,
  Injectable,
  Logger,
  type BeforeApplicationShutdown,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import pg from 'pg';
import { ENV, type Env } from '../config/env.ts';
import { describeError } from '../errors/safe-error.ts';
import { EventsDispatcher } from './events-dispatcher.ts';
import { EVENTS_CHANNEL } from './events.service.ts';
import { StreamRegistry } from './stream-registry.ts';

const BACKOFF_START_MS = 500;
const BACKOFF_MAX_MS = 30_000;

/**
 * The one LISTEN connection of this process. It sits outside the main pool, because a listening
 * connection is never returned to it. Events fan out in memory from here.
 */
@Injectable()
export class EventsListener implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly log = new Logger(EventsListener.name);
  private client: pg.Client | undefined;
  private timer: NodeJS.Timeout | undefined;
  private attempt = 0;
  private stopped = false;

  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly dispatcher: EventsDispatcher,
    private readonly streams: StreamRegistry,
  ) {}

  /** Waits for the first attempt, so a stream opened right after boot hears events. A failure retries in the background. */
  async onApplicationBootstrap(): Promise<void> {
    await this.connect();
  }

  async beforeApplicationShutdown(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    this.streams.closeAll();
    const client = this.client;
    this.client = undefined;
    await client?.end().catch(() => undefined);
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    const client = new pg.Client({
      connectionString: this.env.databaseUrl,
      application_name: 'briefroom-events',
      connectionTimeoutMillis: 10_000,
      keepAlive: true,
    });
    let lost = false;
    const onLost = (err?: unknown): void => {
      if (lost) return;
      lost = true;
      if (this.client === client) this.client = undefined;
      client.end().catch(() => undefined);
      if (this.stopped) return;
      this.log.warn(
        `The event listener lost its connection${err ? `: ${describeError(err)}` : ''}`,
      );
      // Events sent while it was down are gone, so clients reconnect and refetch.
      this.streams.closeAll();
      this.retryLater();
    };
    client.on('error', onLost);
    client.on('end', () => onLost());
    client.on('notification', (msg) => {
      if (msg.channel === EVENTS_CHANNEL) this.dispatcher.dispatch(msg.payload);
    });
    try {
      await client.connect();
      await client.query(`LISTEN ${EVENTS_CHANNEL}`);
    } catch (err) {
      onLost(err);
      return;
    }
    if (this.stopped) {
      await client.end().catch(() => undefined);
      return;
    }
    this.client = client;
    this.attempt = 0;
  }

  private retryLater(): void {
    const delay = Math.min(BACKOFF_START_MS * 2 ** this.attempt, BACKOFF_MAX_MS);
    this.attempt++;
    this.timer = setTimeout(() => void this.connect(), delay);
    this.timer.unref();
  }
}
