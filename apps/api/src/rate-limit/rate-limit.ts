import {
  applyDecorators,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  Module,
  UseGuards,
} from '@nestjs/common';
import { Throttle, ThrottlerGuard, ThrottlerModule, ThrottlerStorage } from '@nestjs/throttler';
import { CLIENT_IP_HEADER } from '../auth/client-ip.middleware.ts';

export const RATE_LIMIT_PER_MINUTE = 20;

/**
 * Keys on the header that the adapter middleware sets from the socket, never on req.ip or a
 * forwarded header the client could have written.
 */
@Injectable()
export class ClientIpThrottlerGuard extends ThrottlerGuard {
  protected override getTracker(req: Record<string, unknown>): Promise<string> {
    const headers = req.headers as Record<string, string | string[] | undefined>;
    const ip = headers[CLIENT_IP_HEADER];
    return Promise.resolve((Array.isArray(ip) ? ip[0] : ip) || 'unknown');
  }

  protected override throwThrottlingException(): Promise<void> {
    throw new HttpException(
      { code: 'rate_limited', message: 'Too many requests. Try again in a minute.' },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}

/** Keys on the signed-in user, so one account's attempts never use up another's on a shared IP. */
@Injectable()
export class UserThrottlerGuard extends ClientIpThrottlerGuard {
  protected override getTracker(req: Record<string, unknown>): Promise<string> {
    const id = (req.session as { user?: { id?: string } } | undefined)?.user?.id;
    return id ? Promise.resolve(`user:${id}`) : super.getTracker(req);
  }
}

export const REFUSED_PER_MINUTE = 30;

const MAX_TRACKED_BLOCKS = 10_000;

interface Block {
  until: number;
  warned: boolean;
}

/**
 * Counts only refused attempts, on the throttler's own storage and the same client-IP key as
 * ClientIpThrottlerGuard. Successful calls never reach record(), so they use no budget. Once an
 * address is over budget it is blocked for the window: assertAllowed() answers 429 before any
 * token is read or verified, a valid one included.
 */
@Injectable()
export class RefusedAttemptLimiter {
  private readonly log = new Logger('RefusedAttempts');
  // The throttler storage cannot be peeked, so blocks are remembered here, bounded in size.
  private readonly blocks = new Map<string, Block>();

  constructor(@Inject(ThrottlerStorage) private readonly storage: ThrottlerStorage) {}

  /** Throws 429 while the address is blocked. Logs once per address per block. */
  assertAllowed(headers: Record<string, string | string[] | undefined>): void {
    const tracker = trackerOf(headers);
    const block = this.blocks.get(tracker);
    if (!block) return;
    if (block.until <= Date.now()) {
      this.blocks.delete(tracker);
      return;
    }
    if (!block.warned) {
      block.warned = true;
      this.log.warn(`Blocking /mcp requests from ${tracker} until the window ends`);
    }
    throw tooMany();
  }

  /** Counts one refusal. Throws 429 once the address has used up its budget for the minute. */
  async record(headers: Record<string, string | string[] | undefined>): Promise<void> {
    const tracker = trackerOf(headers);
    const hit = await this.storage.increment(
      `refused:${tracker}`,
      60_000,
      REFUSED_PER_MINUTE,
      60_000,
      'refused',
    );
    if (!hit.isBlocked) return;
    this.remember(tracker, Date.now() + Math.max(hit.timeToBlockExpire, 1) * 1000);
    throw tooMany();
  }

  /** Forgets every block. For tests that reset the throttle storage. */
  reset(): void {
    this.blocks.clear();
  }

  private remember(tracker: string, until: number): void {
    if (this.blocks.size >= MAX_TRACKED_BLOCKS) {
      const now = Date.now();
      for (const [key, block] of this.blocks) if (block.until <= now) this.blocks.delete(key);
      // Still full of live blocks: drop the oldest, so memory stays bounded.
      const oldest = this.blocks.keys().next().value;
      if (this.blocks.size >= MAX_TRACKED_BLOCKS && oldest !== undefined) {
        this.blocks.delete(oldest);
      }
    }
    this.blocks.set(tracker, { until, warned: this.blocks.get(tracker)?.warned ?? false });
  }
}

function trackerOf(headers: Record<string, string | string[] | undefined>): string {
  const ip = headers[CLIENT_IP_HEADER];
  return (Array.isArray(ip) ? ip[0] : ip) || 'unknown';
}

function tooMany(): HttpException {
  return new HttpException(
    { code: 'rate_limited', message: 'Too many requests. Try again in a minute.' },
    HttpStatus.TOO_MANY_REQUESTS,
  );
}

@Module({
  imports: [
    ThrottlerModule.forRoot({
      throttlers: [{ name: 'default', ttl: 60_000, limit: RATE_LIMIT_PER_MINUTE }],
    }),
  ],
  providers: [ClientIpThrottlerGuard, UserThrottlerGuard, RefusedAttemptLimiter],
  exports: [ThrottlerModule, ClientIpThrottlerGuard, UserThrottlerGuard, RefusedAttemptLimiter],
})
export class RateLimitModule {}

/** Per-route, opt-in: 20 requests a minute per client. The importing module must import RateLimitModule. */
export const RateLimit = () => applyDecorators(UseGuards(ClientIpThrottlerGuard));

/** Per-route, opt-in: `limit` requests a minute per client address, where the default 20 does not fit. */
export const IpRateLimit = (limit: number) =>
  applyDecorators(UseGuards(ClientIpThrottlerGuard), Throttle({ default: { limit, ttl: 60_000 } }));

/** Per-route, opt-in: `limit` requests a minute per signed-in user. */
export const UserRateLimit = (limit: number) =>
  applyDecorators(UseGuards(UserThrottlerGuard), Throttle({ default: { limit, ttl: 60_000 } }));
