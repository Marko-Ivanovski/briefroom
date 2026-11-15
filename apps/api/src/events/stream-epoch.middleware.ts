import { Injectable, type NestMiddleware } from '@nestjs/common';
import { StreamRegistry } from './stream-registry.ts';

export const STREAM_EPOCH = Symbol('STREAM_EPOCH');

/**
 * Runs before the guards, so the epoch is read before the scope is. A revocation that lands between
 * the scope read and the stream opening is then caught by the controller (R135).
 */
@Injectable()
export class StreamEpochMiddleware implements NestMiddleware {
  constructor(private readonly streams: StreamRegistry) {}

  use(req: object, _res: unknown, next: () => void): void {
    (req as Record<symbol, number>)[STREAM_EPOCH] = this.streams.currentEpoch();
    next();
  }
}
