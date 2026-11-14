import type { JoinRequestSummary, JoinResult, JoinSignUp } from '@briefroom/contracts';
import {
  authSchema,
  inviteLinks,
  joinRequests,
  projectAccessChecklist,
  projectMembers,
  projects,
  scoped,
  scopedInsert,
  scopedProjects,
  scopedUpdate,
  workspaceRemovals,
  type Db,
  type InviteRole,
  type JoinRequestStatus,
} from '@briefroom/db';
import {
  ConflictException,
  GoneException,
  HttpException,
  Inject,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { isAPIError } from 'better-auth/api';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Scope } from '../access/scope.ts';
import { AUTH } from '../auth/auth.module.ts';
import type { Auth } from '../auth/auth.ts';
import { DB } from '../database/database.module.ts';
import { describeError } from '../errors/safe-error.ts';
import { RevocationService } from '../members/revocation.service.ts';
import { ProjectMembersService } from '../projects/project-members.service.ts';
import { hashInviteToken, isActive } from './invites.service.ts';

type InviteLinkRow = typeof inviteLinks.$inferSelect;

export interface SignUpOutcome {
  result: JoinResult;
  cookies: string[];
}

const PG_UNIQUE_VIOLATION = '23505';
const DELETE_ATTEMPTS = 3;
const DELETE_BACKOFF_MS = 50;
const MEMBER_UNIQUE = 'member_organization_user_key';
const MEMBER_EXISTS = 'USER_IS_ALREADY_A_MEMBER_OF_THIS_ORGANIZATION';
const PENDING_UNIQUE = 'join_requests_one_pending_per_user';
const JOINER_CODES: ReadonlySet<string> = new Set([
  'invite_invalid',
  'already_member',
  'already_requested',
  'account_exists',
]);
const uuid = z.uuid();

const invalid = () =>
  new GoneException({
    code: 'invite_invalid',
    message: 'This invite link is no longer valid.',
  });
const alreadyMember = () =>
  new ConflictException({ code: 'already_member', message: 'You are already a member.' });
const alreadyRequested = () =>
  new ConflictException({
    code: 'already_requested',
    message: 'You already asked to join this workspace.',
  });
const requestNotFound = () =>
  new NotFoundException({ code: 'not_found', message: 'Join request not found' });

// Drizzle wraps the driver error, so the pg code can sit on a nested `cause`.
function hasPgCode(err: unknown, code: string): boolean {
  for (let e = err, depth = 0; e && typeof e === 'object' && depth < 5; depth++) {
    if ((e as { code?: unknown }).code === code) return true;
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}

function codeOf(err: HttpException): string {
  const body = err.getResponse();
  const code = typeof body === 'object' ? (body as { code?: unknown }).code : undefined;
  return typeof code === 'string' ? code : '';
}

function pgConstraintOf(err: unknown): string | undefined {
  for (let e = err, depth = 0; e && typeof e === 'object' && depth < 5; depth++) {
    const constraint = (e as { constraint?: unknown }).constraint;
    if (typeof constraint === 'string') return constraint;
    e = (e as { cause?: unknown }).cause;
  }
  return undefined;
}

@Injectable()
export class JoinService {
  private readonly logger = new Logger(JoinService.name);

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(AUTH) private readonly auth: Auth,
    private readonly projectMembers: ProjectMembersService,
    private readonly revocation: RevocationService,
  ) {}

  /** Creates the account, signs it in and joins. A failure at any step leaves no account behind. */
  async signUp(token: string, input: JoinSignUp): Promise<SignUpOutcome> {
    const link = await this.findActive(token);
    const email = input.email.toLowerCase();
    const userId = await this.createAccount(input, email);
    try {
      const signedIn = await this.auth.api.signInEmail({
        body: { email, password: input.password },
        asResponse: true,
      });
      if (!signedIn.ok)
        throw new Error(`sign-in after invite sign-up failed with ${signedIn.status}`);
      const result = await this.join(link, userId);
      return { result, cookies: signedIn.headers.getSetCookie() };
    } catch (err) {
      await this.deleteAccount(userId);
      throw this.sanitize(err, 'Invite sign-up failed and was rolled back');
    }
  }

  async accept(token: string, userId: string): Promise<JoinResult> {
    return this.join(await this.findActive(token), userId);
  }

  async listRequests(scope: Scope): Promise<JoinRequestSummary[]> {
    const rows = await this.db
      .select({
        id: joinRequests.id,
        userId: joinRequests.userId,
        name: authSchema.user.name,
        email: authSchema.user.email,
        role: joinRequests.role,
        requestedAt: joinRequests.createdAt,
        emailVerified: authSchema.user.emailVerified,
      })
      .from(joinRequests)
      .innerJoin(authSchema.user, eq(authSchema.user.id, joinRequests.userId))
      .where(and(scoped(scope, joinRequests), eq(joinRequests.status, 'pending')))
      .orderBy(asc(joinRequests.createdAt), asc(joinRequests.id));
    return rows.map((r) => ({ ...r, requestedAt: r.requestedAt.toISOString() }));
  }

  async approve(scope: Scope, id: string): Promise<JoinResult> {
    await this.assertLinkNotRevoked(scope, id);
    // Claiming first makes a double approve safe: only one caller gets the pending row.
    const request = await this.settle(scope, id, 'approved');
    if (await this.isMember(scope.workspaceId, request.userId)) throw alreadyMember();
    try {
      await this.admit(scope, request.userId, request.role, request.projectIds);
    } catch (err) {
      const failure = this.sanitize(err, 'Approving the request failed');
      // A concurrent join already made them a member, so the request is settled as it is.
      if (codeOf(failure) !== 'already_member') await this.reopen(scope, id);
      throw failure;
    }
    await this.db
      .delete(workspaceRemovals)
      .where(
        and(
          eq(workspaceRemovals.workspaceId, scope.workspaceId),
          eq(workspaceRemovals.userId, request.userId),
        ),
      );
    return { status: 'joined', workspaceId: scope.workspaceId };
  }

  // Revoking a link declines its requests already, so this only catches a request that slipped by.
  private async assertLinkNotRevoked(scope: Scope, id: string): Promise<void> {
    if (!uuid.safeParse(id).success) throw requestNotFound();
    const [row] = await this.db
      .select({ revokedAt: inviteLinks.revokedAt })
      .from(joinRequests)
      .innerJoin(inviteLinks, eq(inviteLinks.id, joinRequests.inviteId))
      .where(
        and(
          scoped(scope, joinRequests),
          eq(joinRequests.id, id),
          eq(joinRequests.status, 'pending'),
        ),
      );
    if (!row?.revokedAt) return;
    await this.settle(scope, id, 'declined');
    throw new ConflictException({
      code: 'invite_revoked',
      message: 'The invite link for this request was revoked.',
    });
  }

  async decline(scope: Scope, id: string): Promise<void> {
    await this.settle(scope, id, 'declined');
  }

  private async settle(scope: Scope, id: string, status: 'approved' | 'declined') {
    if (!uuid.safeParse(id).success) throw requestNotFound();
    const values: { status: JoinRequestStatus } = { status };
    const [row] = await this.db
      .update(joinRequests)
      .set(scopedUpdate(scope, values))
      .where(
        and(
          scoped(scope, joinRequests),
          eq(joinRequests.id, id),
          eq(joinRequests.status, 'pending'),
        ),
      )
      .returning();
    if (!row) throw requestNotFound();
    return row;
  }

  private async reopen(scope: Scope, id: string): Promise<void> {
    try {
      const values: { status: JoinRequestStatus } = { status: 'pending' };
      await this.db
        .update(joinRequests)
        .set(scopedUpdate(scope, values))
        .where(and(scoped(scope, joinRequests), eq(joinRequests.id, id)));
    } catch (err) {
      this.logger.error(`Reopening join request ${id} failed: ${describeError(err)}`);
    }
  }

  private async findActive(token: string): Promise<InviteLinkRow> {
    const [link] = await this.db
      .select()
      .from(inviteLinks)
      .where(and(eq(inviteLinks.tokenHash, hashInviteToken(token)), isActive()));
    if (!link) throw invalid();
    return link;
  }

  private async join(link: InviteLinkRow, userId: string): Promise<JoinResult> {
    // Both checks come before the use is reserved, so a refused attempt never burns one.
    if (await this.isMember(link.workspaceId, userId)) throw alreadyMember();
    if (await this.hasPending(link.workspaceId, userId)) throw alreadyRequested();

    const reserved = await this.reserveUse(link.id);
    const scope = this.joinerScope(reserved.workspaceId, userId, reserved.role);
    try {
      // R87 again at join time, in case the stored flag was ever cleared on an admin link.
      if (
        reserved.requiresApproval ||
        reserved.role === 'admin' ||
        (await this.wasRemoved(reserved.workspaceId, userId))
      ) {
        await this.db.insert(joinRequests).values(
          scopedInsert(scope, {
            inviteId: reserved.id,
            userId,
            role: reserved.role,
            projectIds: reserved.projectIds,
          }),
        );
        return { status: 'pending' };
      }
      await this.admit(scope, userId, reserved.role, reserved.projectIds);
      return { status: 'joined', workspaceId: reserved.workspaceId };
    } catch (err) {
      await this.releaseUse(reserved.id);
      throw this.sanitize(err, 'Joining failed');
    }
  }

  // The only place a use is counted. One statement, so two accepts of a last use cannot both win.
  private async reserveUse(inviteId: string): Promise<InviteLinkRow> {
    const [row] = await this.db
      .update(inviteLinks)
      .set({ uses: sql`${inviteLinks.uses} + 1` })
      .where(and(eq(inviteLinks.id, inviteId), isActive()))
      .returning();
    if (!row) throw invalid();
    return row;
  }

  private async releaseUse(inviteId: string): Promise<void> {
    try {
      await this.db
        .update(inviteLinks)
        .set({ uses: sql`greatest(${inviteLinks.uses} - 1, 0)` })
        .where(eq(inviteLinks.id, inviteId));
    } catch (err) {
      this.logger.error(`Releasing an invite use failed: ${describeError(err)}`);
    }
  }

  /** Better Auth cannot share our transaction, so a failed project step undoes exactly what this call created. */
  private async admit(
    scope: Scope,
    userId: string,
    role: InviteRole,
    projectIds: string[],
  ): Promise<void> {
    const member = await this.auth.api.addMember({
      body: { userId, role, organizationId: scope.workspaceId },
    });
    const added: string[] = [];
    try {
      await this.addToProjects(scope, userId, projectIds, added);
    } catch (err) {
      await this.undoAdmit(scope.workspaceId, userId, member.id, added);
      throw err;
    }
  }

  // Regenerate keeps project ids that were deleted since, so only the ones that still exist count.
  private async addToProjects(
    scope: Scope,
    userId: string,
    projectIds: string[],
    added: string[],
  ): Promise<void> {
    if (projectIds.length === 0) return;
    const existing = await this.db
      .select({ id: projects.id })
      .from(projects)
      .where(and(scopedProjects(scope), inArray(projects.id, projectIds)));
    const alive = new Set(existing.map((p) => p.id));
    for (const projectId of projectIds) {
      if (!alive.has(projectId)) continue;
      try {
        await this.projectMembers.add(scope, projectId, userId);
        added.push(projectId);
      } catch (err) {
        // Deleted between the lookup above and the add.
        if (!(err instanceof NotFoundException)) throw err;
      }
    }
  }

  private async undoAdmit(
    workspaceId: string,
    userId: string,
    memberId: string,
    addedProjectIds: string[],
  ): Promise<void> {
    try {
      await this.db.delete(authSchema.member).where(eq(authSchema.member.id, memberId));
      if (addedProjectIds.length === 0) return;
      await this.db
        .delete(projectMembers)
        .where(
          and(
            eq(projectMembers.workspaceId, workspaceId),
            eq(projectMembers.userId, userId),
            inArray(projectMembers.projectId, addedProjectIds),
          ),
        );
      await this.db
        .delete(projectAccessChecklist)
        .where(
          and(
            eq(projectAccessChecklist.workspaceId, workspaceId),
            eq(projectAccessChecklist.userId, userId),
            eq(projectAccessChecklist.kind, 'add'),
            inArray(projectAccessChecklist.projectId, addedProjectIds),
          ),
        );
    } catch (err) {
      this.logger.error(`Undoing a failed join failed, clean up by hand: ${describeError(err)}`);
    }
  }

  private async createAccount(input: JoinSignUp, email: string): Promise<string> {
    try {
      const created = await this.auth.api.createUser({
        body: { email, password: input.password, name: input.name },
      });
      return created.user.id;
    } catch (err) {
      const exists =
        (isAPIError(err) && String(err.body?.code ?? '').startsWith('USER_ALREADY_EXISTS')) ||
        hasPgCode(err, PG_UNIQUE_VIOLATION);
      if (exists) {
        throw new ConflictException({
          code: 'account_exists',
          message: 'An account with this email already exists. Sign in instead.',
        });
      }
      throw err;
    }
  }

  // Sessions go first: even if the account delete keeps failing, nobody is left signed in.
  // FKs cascade the memberships, project memberships and join requests of the account.
  private async deleteAccount(userId: string): Promise<void> {
    for (let attempt = 1; attempt <= DELETE_ATTEMPTS; attempt++) {
      try {
        await (await this.auth.$context).internalAdapter.deleteUserSessions(userId);
        await this.revocation.sessionsRevoked(userId);
        await this.db.delete(authSchema.user).where(eq(authSchema.user.id, userId));
        return;
      } catch (err) {
        if (attempt === DELETE_ATTEMPTS) {
          this.logger.error(
            `Deleting half-made account ${userId} failed, clean up by hand: ${describeError(err)}`,
          );
        } else {
          await new Promise((resolve) => setTimeout(resolve, DELETE_BACKOFF_MS * attempt));
        }
      }
    }
  }

  private async isMember(workspaceId: string, userId: string): Promise<boolean> {
    const [row] = await this.db
      .select({ id: authSchema.member.id })
      .from(authSchema.member)
      .where(
        and(
          eq(authSchema.member.organizationId, workspaceId),
          eq(authSchema.member.userId, userId),
        ),
      );
    return Boolean(row);
  }

  // R101: someone who was removed from or left a workspace needs approval to join it again.
  private async wasRemoved(workspaceId: string, userId: string): Promise<boolean> {
    const [row] = await this.db
      .select({ id: workspaceRemovals.id })
      .from(workspaceRemovals)
      .where(
        and(eq(workspaceRemovals.workspaceId, workspaceId), eq(workspaceRemovals.userId, userId)),
      );
    return Boolean(row);
  }

  private async hasPending(workspaceId: string, userId: string): Promise<boolean> {
    const [row] = await this.db
      .select({ id: joinRequests.id })
      .from(joinRequests)
      .where(
        and(
          eq(joinRequests.workspaceId, workspaceId),
          eq(joinRequests.userId, userId),
          eq(joinRequests.status, 'pending'),
        ),
      );
    return Boolean(row);
  }

  private joinerScope(workspaceId: string, userId: string, role: InviteRole): Scope {
    return {
      userId,
      workspaceId,
      role,
      visibleProjectIds: 'all',
      permissions: new Set(),
      actor: { userId, via: 'web' },
    };
  }

  /**
   * Only the join contract's codes reach the joiner. A unique violation is a lost race, and
   * anything else may carry SQL parameters, emails or internal codes, so it becomes a generic 500.
   */
  private sanitize(err: unknown, logLine: string): HttpException {
    const constraint = pgConstraintOf(err);
    if (constraint === MEMBER_UNIQUE || (isAPIError(err) && err.body?.code === MEMBER_EXISTS)) {
      return alreadyMember();
    }
    if (constraint === PENDING_UNIQUE) return alreadyRequested();
    // join_failed passes through so an error sanitized once is not logged twice.
    if (
      err instanceof HttpException &&
      (JOINER_CODES.has(codeOf(err)) || codeOf(err) === 'join_failed')
    ) {
      return err;
    }
    this.logger.error(`${logLine}: ${describeError(err)}`);
    return new InternalServerErrorException({
      code: 'join_failed',
      message: 'Joining failed. Try again.',
    });
  }
}
