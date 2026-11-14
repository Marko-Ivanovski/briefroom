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
import { ProjectMembersService } from '../projects/project-members.service.ts';
import { hashInviteToken, isActive } from './invites.service.ts';

type InviteLinkRow = typeof inviteLinks.$inferSelect;

export interface SignUpOutcome {
  result: JoinResult;
  cookies: string[];
}

const PG_UNIQUE_VIOLATION = '23505';
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

@Injectable()
export class JoinService {
  private readonly logger = new Logger(JoinService.name);

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(AUTH) private readonly auth: Auth,
    private readonly projectMembers: ProjectMembersService,
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
      })
      .from(joinRequests)
      .innerJoin(authSchema.user, eq(authSchema.user.id, joinRequests.userId))
      .where(and(scoped(scope, joinRequests), eq(joinRequests.status, 'pending')))
      .orderBy(asc(joinRequests.createdAt), asc(joinRequests.id));
    return rows.map((r) => ({ ...r, requestedAt: r.requestedAt.toISOString() }));
  }

  async approve(scope: Scope, id: string): Promise<JoinResult> {
    // Claiming first makes a double approve safe: only one caller gets the pending row.
    const request = await this.settle(scope, id, 'approved');
    if (await this.isMember(scope.workspaceId, request.userId)) throw alreadyMember();
    try {
      await this.admit(scope, request.userId, request.role, request.projectIds);
    } catch (err) {
      await this.reopen(scope, id);
      throw this.sanitize(err, 'Approving the request failed');
    }
    return { status: 'joined', workspaceId: scope.workspaceId };
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
      if (reserved.requiresApproval) {
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
      if (hasPgCode(err, PG_UNIQUE_VIOLATION)) throw alreadyRequested();
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

  /** Better Auth cannot share our transaction, so a failed project step undoes the member by hand. */
  private async admit(
    scope: Scope,
    userId: string,
    role: InviteRole,
    projectIds: string[],
  ): Promise<void> {
    await this.auth.api.addMember({
      body: { userId, role, organizationId: scope.workspaceId },
    });
    try {
      await this.addToProjects(scope, userId, projectIds);
    } catch (err) {
      await this.undoAdmit(scope.workspaceId, userId, projectIds);
      throw err;
    }
  }

  // Regenerate keeps project ids that were deleted since, so only the ones that still exist count.
  private async addToProjects(scope: Scope, userId: string, projectIds: string[]): Promise<void> {
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
      } catch (err) {
        // Deleted between the lookup above and the add.
        if (!(err instanceof NotFoundException)) throw err;
      }
    }
  }

  private async undoAdmit(
    workspaceId: string,
    userId: string,
    projectIds: string[],
  ): Promise<void> {
    try {
      await this.db
        .delete(authSchema.member)
        .where(
          and(
            eq(authSchema.member.organizationId, workspaceId),
            eq(authSchema.member.userId, userId),
          ),
        );
      if (projectIds.length === 0) return;
      const mine = and(
        eq(projectMembers.workspaceId, workspaceId),
        eq(projectMembers.userId, userId),
        inArray(projectMembers.projectId, projectIds),
      );
      await this.db.delete(projectMembers).where(mine);
      await this.db
        .delete(projectAccessChecklist)
        .where(
          and(
            eq(projectAccessChecklist.workspaceId, workspaceId),
            eq(projectAccessChecklist.userId, userId),
            eq(projectAccessChecklist.kind, 'add'),
            inArray(projectAccessChecklist.projectId, projectIds),
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

  // FKs cascade the account's sessions, memberships, project memberships and join requests.
  private async deleteAccount(userId: string): Promise<void> {
    try {
      await this.db.delete(authSchema.user).where(eq(authSchema.user.id, userId));
    } catch (err) {
      this.logger.error(
        `Deleting a half-made account failed, clean up by hand: ${describeError(err)}`,
      );
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

  /** Known HTTP errors pass through. Anything else may carry SQL parameters or emails, so it becomes a generic 500. */
  private sanitize(err: unknown, logLine: string): HttpException {
    if (err instanceof HttpException) return err;
    this.logger.error(`${logLine}: ${describeError(err)}`);
    return new InternalServerErrorException({
      code: 'join_failed',
      message: 'Joining failed. Try again.',
    });
  }
}
