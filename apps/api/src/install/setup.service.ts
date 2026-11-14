import type { SetupRequest, SetupResponse } from '@briefroom/contracts';
import { authSchema, type Db } from '@briefroom/db';
import {
  GoneException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  InternalServerErrorException,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { AUTH } from '../auth/auth.module.ts';
import type { Auth } from '../auth/auth.ts';
import { DB } from '../database/database.module.ts';
import { describeError } from '../errors/safe-error.ts';
import { workspaceSlug } from '../workspaces/workspace-slug.ts';
import { InstallService } from './install.service.ts';
import { setupCodeMatches } from './setup-code.ts';

export const MAX_FAILED_SETUP_ATTEMPTS = 10;
const SETUP_LOCK = `hashtext('briefroom:setup')`;

export interface SetupResult extends SetupResponse {
  cookies: string[];
}

@Injectable()
export class SetupService {
  private readonly logger = new Logger(SetupService.name);

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(AUTH) private readonly auth: Auth,
    private readonly installs: InstallService,
  ) {}

  async needsSetup(): Promise<boolean> {
    return (await this.installs.getRow()).ownerUserId === null;
  }

  async setup(req: SetupRequest): Promise<SetupResult> {
    await this.installs.getRow();
    const attempt = await this.installs.reserveAttempt(MAX_FAILED_SETUP_ATTEMPTS);
    if (attempt.status === 'done') throw new GoneException('Setup is already done');
    if (attempt.status === 'locked') {
      throw new HttpException(
        'Too many wrong setup codes. Restart Briefroom to get a new code.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    if (!attempt.setupCodeHash || !setupCodeMatches(req.code, attempt.setupCodeHash)) {
      throw new UnauthorizedException('Wrong setup code');
    }

    // The auth adapter cannot share one transaction with the install row, so the lock keeps two
    // setups apart and the owner is written last: a failure leaves nothing to unpick but the new rows.
    const lock = await this.db.$client.connect();
    let destroy = false;
    try {
      await lock.query(`SELECT pg_advisory_lock(${SETUP_LOCK})`);
      try {
        if ((await this.installs.getRow()).ownerUserId) {
          throw new GoneException('Setup is already done');
        }
        await this.clearLeftovers();
        return await this.createOwner(req);
      } finally {
        // A client that still holds the lock must not go back to the pool: closing it frees the lock.
        try {
          await lock.query(`SELECT pg_advisory_unlock(${SETUP_LOCK})`);
        } catch (err) {
          destroy = true;
          this.logger.error(`Releasing the setup lock failed: ${describeError(err)}`);
        }
      }
    } finally {
      lock.release(destroy);
    }
  }

  // Public sign-up is off and setup is the only way to create users, so before an owner exists any
  // user, workspace or key is debris from a crashed setup. FKs cascade member, session and account.
  private async clearLeftovers(): Promise<void> {
    await this.db.delete(authSchema.apikey);
    await this.db.delete(authSchema.organization);
    await this.db.delete(authSchema.user);
  }

  private async createOwner(req: SetupRequest): Promise<SetupResult> {
    const slug = workspaceSlug(req.name);
    let userId: string | undefined;
    try {
      const created = await this.auth.api.createUser({
        body: { email: req.email, password: req.password, name: req.name },
      });
      userId = created.user.id;
      const ownerId = userId;
      const workspace = await this.installs.runAsSetupOf(ownerId, () =>
        this.auth.api.createOrganization({
          body: { name: `${req.name}'s workspace`, slug, userId: ownerId },
        }),
      );
      const signedIn = await this.auth.api.signInEmail({
        body: { email: req.email, password: req.password },
        asResponse: true,
      });
      if (!signedIn.ok) throw new Error(`sign-in after setup failed with ${signedIn.status}`);
      await this.installs.completeSetup(ownerId);
      return {
        userId: ownerId,
        workspaceId: workspace.id,
        cookies: signedIn.headers.getSetCookie(),
      };
    } catch (err) {
      await this.rollback(slug, userId);
      this.logger.error(`First-run setup failed and was rolled back: ${describeError(err)}`);
      throw new InternalServerErrorException('Setup failed and was rolled back');
    }
  }

  private async rollback(slug: string, userId: string | undefined): Promise<void> {
    try {
      await this.db.delete(authSchema.organization).where(eq(authSchema.organization.slug, slug));
      if (userId) await this.db.delete(authSchema.user).where(eq(authSchema.user.id, userId));
    } catch (cleanupErr) {
      this.logger.error(`Setup rollback failed, clean up by hand: ${describeError(cleanupErr)}`);
    }
  }
}
