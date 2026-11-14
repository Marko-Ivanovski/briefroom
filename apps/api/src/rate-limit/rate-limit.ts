import {
  applyDecorators,
  HttpException,
  HttpStatus,
  Injectable,
  Module,
  UseGuards,
} from '@nestjs/common';
import { Throttle, ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
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

@Module({
  imports: [
    ThrottlerModule.forRoot({
      throttlers: [{ name: 'default', ttl: 60_000, limit: RATE_LIMIT_PER_MINUTE }],
    }),
  ],
  providers: [ClientIpThrottlerGuard, UserThrottlerGuard],
  exports: [ThrottlerModule, ClientIpThrottlerGuard, UserThrottlerGuard],
})
export class RateLimitModule {}

/** Per-route, opt-in: 20 requests a minute per client. The importing module must import RateLimitModule. */
export const RateLimit = () => applyDecorators(UseGuards(ClientIpThrottlerGuard));

/** Per-route, opt-in: `limit` requests a minute per signed-in user. */
export const UserRateLimit = (limit: number) =>
  applyDecorators(UseGuards(UserThrottlerGuard), Throttle({ default: { limit, ttl: 60_000 } }));
