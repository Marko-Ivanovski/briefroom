import type { ResetLinkResponse } from '@briefroom/contracts';
import { authSchema, passwordResetLinks, updatedStamp, type Db } from '@briefroom/db';
import {
  BadRequestException,
  ForbiddenException,
  GoneException,
  HttpException,
  Inject,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import type { Scope } from '../access/scope.ts';
import { RevocationService } from './revocation.service.ts';
import { AUTH } from '../auth/auth.module.ts';
import type { Auth } from '../auth/auth.ts';
import { DB } from '../database/database.module.ts';
import { InstallService } from '../install/install.service.ts';
import { hashResetToken, PasswordResetLinks } from './password-reset-links.service.ts';

const ADMIN_ROLES: ReadonlySet<string> = new Set(['admin', 'owner']);

/** The password is install-wide, so a failed query here must never reach a log: its message carries the parameters. */
class PasswordWriteFailed extends Error {}

@Injectable()
export class PasswordResetService {
  private readonly log = new Logger(PasswordResetService.name);

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(AUTH) private readonly auth: Auth,
    private readonly installs: InstallService,
    private readonly links: PasswordResetLinks,
    private readonly revocation: RevocationService,
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
    if (!(await this.mayReset(scope.userId, targetUserId))) {
      throw new ForbiddenException('You cannot reset this account');
    }

    const { url, expiresAt } = await this.links.issue(targetUserId, scope.workspaceId, scope.actor);
    this.log.log(`reset link issued for user ${targetUserId} by ${scope.userId}`);
    return { url, expiresAt: expiresAt.toISOString() };
  }

  /**
   * Passwords are install-wide, so the rule is too: the install owner may reset anyone. An admin may
   * reset only a plain member whose every workspace is one the admin also administers.
   */
  private async mayReset(issuerId: string, targetUserId: string): Promise<boolean> {
    if (await this.installs.isInstallOwner(issuerId)) return true;
    if (await this.installs.isInstallOwner(targetUserId)) return false;

    const targetRows = await this.db
      .select({ workspaceId: authSchema.member.organizationId, role: authSchema.member.role })
      .from(authSchema.member)
      .where(eq(authSchema.member.userId, targetUserId));
    if (targetRows.length === 0 || targetRows.some((r) => r.role !== 'member')) return false;

    const issuerRows = await this.db
      .select({ workspaceId: authSchema.member.organizationId, role: authSchema.member.role })
      .from(authSchema.member)
      .where(eq(authSchema.member.userId, issuerId));
    const administered = new Set(
      issuerRows.filter((r) => ADMIN_ROLES.has(r.role)).map((r) => r.workspaceId),
    );
    return targetRows.every((r) => administered.has(r.workspaceId));
  }

  async redeem(token: string, password: string): Promise<void> {
    try {
      await this.redeemUnsafe(token, password);
    } catch (err) {
      if (err instanceof HttpException) throw err;
      this.log.error(
        `password reset failed: ${err instanceof PasswordWriteFailed ? 'write' : 'error'}`,
      );
      throw new InternalServerErrorException();
    }
  }

  private async redeemUnsafe(token: string, password: string): Promise<void> {
    const ctx = await this.auth.$context;
    const tokenHash = hashResetToken(token);

    // Hashing costs real CPU and this route is anonymous, so an unknown, used or expired token is
    // turned away before any hash. The claim below stays the real guard against parallel uses.
    const [live] = await this.db
      .select({ id: passwordResetLinks.id })
      .from(passwordResetLinks)
      .where(
        and(
          eq(passwordResetLinks.tokenHash, tokenHash),
          isNull(passwordResetLinks.usedAt),
          gt(passwordResetLinks.expiresAt, sql`now()`),
        ),
      );
    if (!live) throw new GoneException('This reset link is no longer valid');

    const hash = await ctx.password.hash(password);

    // One statement claims the link, so two parallel uses cannot both pass.
    const [claimed] = await this.db
      .update(passwordResetLinks)
      .set({ usedAt: sql`now()`, ...updatedStamp({ userId: 'reset-link', via: 'web' }) })
      .where(
        and(
          eq(passwordResetLinks.tokenHash, tokenHash),
          isNull(passwordResetLinks.usedAt),
          gt(passwordResetLinks.expiresAt, sql`now()`),
        ),
      )
      .returning({
        id: passwordResetLinks.id,
        userId: passwordResetLinks.userId,
        workspaceId: passwordResetLinks.workspaceId,
        issuerId: passwordResetLinks.createdBy,
      });
    if (!claimed) throw new GoneException('This reset link is no longer valid');

    if (claimed.workspaceId && !(await this.issuerStillMayReset(claimed))) {
      this.log.warn(`reset link for user ${claimed.userId} refused: issuer no longer allowed`);
      throw new GoneException('This reset link is no longer valid');
    }

    // Sessions are revoked before and after the write, so a failed revoke can never leave an old
    // (possibly hostile) session alive beside a changed password.
    try {
      await ctx.internalAdapter.deleteUserSessions(claimed.userId);
      await this.revocation.sessionsRevoked(claimed.userId);
      await this.revocation.passwordReset(claimed.userId);
      if (!(await ctx.internalAdapter.findCredentialAccount(claimed.userId))) {
        throw new PasswordWriteFailed();
      }
      await ctx.internalAdapter.updatePassword(claimed.userId, hash);
    } catch (err) {
      await this.db
        .update(passwordResetLinks)
        .set({ usedAt: null })
        .where(eq(passwordResetLinks.id, claimed.id));
      throw err instanceof PasswordWriteFailed ? err : new PasswordWriteFailed();
    }

    let failed = false;
    try {
      await ctx.internalAdapter.deleteUserSessions(claimed.userId);
      await this.revocation.sessionsRevoked(claimed.userId);
      await this.revocation.passwordReset(claimed.userId);
    } catch {
      failed = true;
    }
    try {
      await this.db
        .update(passwordResetLinks)
        .set({ usedAt: sql`now()`, ...updatedStamp({ userId: 'reset-link', via: 'web' }) })
        .where(
          and(eq(passwordResetLinks.userId, claimed.userId), isNull(passwordResetLinks.usedAt)),
        );
    } catch {
      failed = true;
    }
    if (failed) {
      this.log.error(
        `password reset for user ${claimed.userId} set the password but cleanup failed`,
      );
      throw new PasswordWriteFailed();
    }
    this.log.log(`password reset for user ${claimed.userId}`);
  }

  private async issuerStillMayReset(link: {
    userId: string;
    workspaceId: string | null;
    issuerId: string;
  }): Promise<boolean> {
    if (await this.installs.isInstallOwner(link.issuerId)) return true;
    const [stillMember] = await this.db
      .select({ id: authSchema.member.id })
      .from(authSchema.member)
      .where(
        and(
          eq(authSchema.member.userId, link.userId),
          eq(authSchema.member.organizationId, link.workspaceId!),
        ),
      );
    return !!stillMember && (await this.mayReset(link.issuerId, link.userId));
  }
}
