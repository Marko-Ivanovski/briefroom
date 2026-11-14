import { ResetPasswordRequest } from '@briefroom/contracts';
import { BadRequestException, Body, Controller, HttpCode, Param, Post } from '@nestjs/common';
import { AllowAnonymous } from '@thallesp/nestjs-better-auth';
import { PasswordResetService } from './password-reset.service.ts';

@AllowAnonymous()
@Controller('v1/reset')
export class PasswordResetController {
  constructor(private readonly resets: PasswordResetService) {}

  @Post(':token')
  @HttpCode(204)
  async redeem(@Param('token') token: string, @Body() body: unknown): Promise<void> {
    const parsed = ResetPasswordRequest.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.issues.map((i) => i.message).join('; '));
    }
    await this.resets.redeem(token, parsed.data.password);
  }
}
