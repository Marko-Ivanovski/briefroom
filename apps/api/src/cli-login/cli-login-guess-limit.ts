import { createHash } from 'node:crypto';
import { applyDecorators, Injectable, UseGuards, type ExecutionContext } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { UserThrottlerGuard } from '../rate-limit/rate-limit.ts';

/** One counter per user for every route that takes a login code, so preview is no cheaper to guess with than approve. */
@Injectable()
export class CliLoginGuessGuard extends UserThrottlerGuard {
  protected override generateKey(_context: ExecutionContext, suffix: string, name: string): string {
    return createHash('sha256').update(`cli-login-guess-${name}-${suffix}`).digest('hex');
  }
}

export const CliLoginGuessLimit = (limit: number) =>
  applyDecorators(UseGuards(CliLoginGuessGuard), Throttle({ default: { limit, ttl: 60_000 } }));
