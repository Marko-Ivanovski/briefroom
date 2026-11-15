import {
  CliLoginApprove,
  CliLoginPoll,
  CliLoginStart,
  type CliLoginApproved,
  type CliLoginPollResult,
  type CliLoginStarted,
} from '@briefroom/contracts';
import { BadRequestException, Body, Controller, HttpCode, Post } from '@nestjs/common';
import { AllowAnonymous } from '@thallesp/nestjs-better-auth';
import { CurrentUser, type CurrentUserData } from '../auth/current-user.decorator.ts';
import { IpRateLimit, UserRateLimit } from '../rate-limit/rate-limit.ts';
import { CliLoginService } from './cli-login.service.ts';

const START_PER_MINUTE = 10;
// The CLI polls every 2 seconds, so 30 a minute is normal. The rest is headroom for a shared address.
const POLL_PER_MINUTE = 60;
// Per user, against guessing codes: 8 characters from 31 stay out of reach at this rate.
const APPROVE_PER_MINUTE = 10;

function parse<T>(
  schema: { safeParse(v: unknown): { success: true; data: T } | { success: false } },
  body: unknown,
): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new BadRequestException('Invalid request body');
  return parsed.data;
}

@Controller('v1/cli-login')
export class CliLoginController {
  constructor(private readonly logins: CliLoginService) {}

  @AllowAnonymous()
  @IpRateLimit(START_PER_MINUTE)
  @Post()
  start(@Body() body: unknown): Promise<CliLoginStarted> {
    return this.logins.start(parse(CliLoginStart, body ?? {}).deviceName);
  }

  @AllowAnonymous()
  @IpRateLimit(POLL_PER_MINUTE)
  @Post('poll')
  @HttpCode(200)
  poll(@Body() body: unknown): Promise<CliLoginPollResult> {
    return this.logins.poll(parse(CliLoginPoll, body).pollToken);
  }

  @UserRateLimit(APPROVE_PER_MINUTE)
  @Post('approve')
  @HttpCode(200)
  approve(@CurrentUser() user: CurrentUserData, @Body() body: unknown): Promise<CliLoginApproved> {
    return this.logins.approve(user.id, parse(CliLoginApprove, body));
  }
}
