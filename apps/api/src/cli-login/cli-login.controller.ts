import {
  CliLoginApprove,
  CliLoginPoll,
  CliLoginPreview,
  CliLoginStart,
  type CliLoginApproved,
  type CliLoginPollResult,
  type CliLoginPreviewed,
  type CliLoginStarted,
} from '@briefroom/contracts';
import { BadRequestException, Body, Controller, HttpCode, Post, Req } from '@nestjs/common';
import { AllowAnonymous } from '@thallesp/nestjs-better-auth';
import { CurrentUser, type CurrentUserData } from '../auth/current-user.decorator.ts';
import { CLIENT_IP_HEADER } from '../auth/client-ip.middleware.ts';
import { IpRateLimit } from '../rate-limit/rate-limit.ts';
import { CliLoginGuessLimit } from './cli-login-guess-limit.ts';
import { CliLoginService } from './cli-login.service.ts';

const START_PER_MINUTE = 10;
// The CLI polls every 2 seconds, so 30 a minute is normal. The rest is headroom for a shared address.
const POLL_PER_MINUTE = 60;
// Per user and shared by preview and approve, against guessing codes: 8 characters from 31 stay out of reach at this rate.
const GUESS_PER_MINUTE = 10;

interface LoginRequest {
  headers: Record<string, string | string[] | undefined>;
  session?: { session?: { id: string } } | null;
}

const first = (v: string | string[] | undefined): string | undefined =>
  Array.isArray(v) ? v[0] : v;

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
  start(@Req() req: LoginRequest, @Body() body: unknown): Promise<CliLoginStarted> {
    return this.logins.start(parse(CliLoginStart, body ?? {}).deviceName, {
      ip: first(req.headers[CLIENT_IP_HEADER]),
      userAgent: first(req.headers['user-agent']),
    });
  }

  @AllowAnonymous()
  @IpRateLimit(POLL_PER_MINUTE)
  @Post('poll')
  @HttpCode(200)
  poll(@Body() body: unknown): Promise<CliLoginPollResult> {
    return this.logins.poll(parse(CliLoginPoll, body).pollToken);
  }

  @CliLoginGuessLimit(GUESS_PER_MINUTE)
  @Post('preview')
  @HttpCode(200)
  preview(@Req() req: LoginRequest, @Body() body: unknown): Promise<CliLoginPreviewed> {
    return this.logins.preview(
      parse(CliLoginPreview, body).code,
      first(req.headers[CLIENT_IP_HEADER]),
    );
  }

  @CliLoginGuessLimit(GUESS_PER_MINUTE)
  @Post('approve')
  @HttpCode(200)
  approve(
    @CurrentUser() user: CurrentUserData,
    @Req() req: LoginRequest,
    @Body() body: unknown,
  ): Promise<CliLoginApproved> {
    return this.logins.approve(
      user.id,
      req.session?.session?.id ?? '',
      parse(CliLoginApprove, body),
    );
  }
}
