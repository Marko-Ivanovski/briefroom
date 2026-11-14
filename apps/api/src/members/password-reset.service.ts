import type { ResetLinkResponse } from '@briefroom/contracts';
import { authSchema, passwordResetLinks, updatedStamp, type Db } from '@briefroom/db';
import {
  BadRequestException,
  ForbiddenException,
  GoneException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import type { Scope } from '../access/scope.ts';
import { AUTH } from '../auth/auth.module.ts';
import type { Auth } from '../auth/auth.ts';
import { DB } from '../database/database.module.ts';
import { InstallService } from '../install/install.service.ts';
import { hashResetToken, PasswordResetLinks } from './password-reset-links.service.ts';

@Injectable()
export class PasswordResetService {
  private readonly log = new Logger(PasswordResetService.name);

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(AUTH) private readonly auth: Auth,
    private readonly installs: InstallService,
    private readonly links: PasswordResetLinks,
  ) {}

  async createForMember(scope: Scope, targetUserId: string): Promise<ResetLinkResponse> {
    if (targetUserId === scope.userId) {
      throw new BadRequestException('Change your own password by signing in');
    }
    const [target] = await this.db
      .select({ role: authSchema.member.role })
      .from(authSchema.member)
      .where(
        and(
          eq(authSchema.member.organizationId, scope.workspaceId),
          eq(authSchema.member.userId, targetUserId),
        ),
      );
    if (!target) throw new NotFoundException('Member not found');
    if (target.role !== 'member' && !(await this.installs.isInstallOwner(scope.userId))) {
      throw new ForbiddenException('Only the install owner can reset an admin or owner');
    }

    const { url, expiresAt } = await this.links.issue(targetUserId, scope.workspaceId, scope.actor);
    this.log.log(`reset link issued for user ${targetUserId} by ${scope.userId}`);
    return { url, expiresAt: expiresAt.toISOString() };
  }

  async redeem(token: string, password: string): Promise<void> {
    // One statement claims the link, so two parallel uses cannot both pass.
    const [claimed] = await this.db
      .update(passwordResetLinks)
      .set({ usedAt: sql`now()`, ...updatedStamp({ userId: 'reset-link', via: 'web' }) })
      .where(
        and(
          eq(passwordResetLinks.tokenHash, hashResetToken(token)),
          isNull(passwordResetLinks.usedAt),
          gt(passwordResetLinks.expiresAt, sql`now()`),
        ),
      )
      .returning({ id: passwordResetLinks.id, userId: passwordResetLinks.userId });
    if (!claimed) throw new GoneException('This reset link is no longer valid');

    try {
      const ctx = await this.auth.$context;
      await ctx.internalAdapter.updatePassword(claimed.userId, await ctx.password.hash(password));
      await ctx.internalAdapter.deleteUserSessions(claimed.userId);
    } catch (err) {
      await this.db
        .update(passwordResetLinks)
        .set({ usedAt: null })
        .where(eq(passwordResetLinks.id, claimed.id));
      this.log.error(`password reset failed for user ${claimed.userId}`);
      throw err;
    }
    this.log.log(`password reset for user ${claimed.userId}`);
  }
}
