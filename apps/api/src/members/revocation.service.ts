import { Injectable, Logger } from '@nestjs/common';
import { describeError } from '../errors/safe-error.ts';

export type MemberRemovedHandler = (workspaceId: string, userId: string) => Promise<void>;
export type ProjectMemberRemovedHandler = (
  workspaceId: string,
  projectId: string,
  userId: string,
) => Promise<void>;

const HANDLER_TIMEOUT_MS = 5000;

/**
 * Registry for things that must stop at once when access ends: API tokens (Task 7.1) and live
 * streams (Task 6.4) register handlers here. One failing handler never blocks the others.
 */
@Injectable()
export class RevocationService {
  private readonly log = new Logger(RevocationService.name);
  private readonly memberHandlers: MemberRemovedHandler[] = [];
  private readonly projectHandlers: ProjectMemberRemovedHandler[] = [];
  private readonly roleHandlers: MemberRemovedHandler[] = [];
  private readonly addedHandlers: MemberRemovedHandler[] = [];
  private readonly sessionHandlers: ((userId: string) => Promise<void>)[] = [];
  private readonly passwordResetHandlers: ((userId: string) => Promise<void>)[] = [];

  onMemberRemoved(handler: MemberRemovedHandler): void {
    this.memberHandlers.push(handler);
  }

  onProjectMemberAdded(handler: MemberRemovedHandler): void {
    this.addedHandlers.push(handler);
  }

  projectMemberAdded(workspaceId: string, userId: string): Promise<void> {
    return this.run(
      'projectMemberAdded',
      this.addedHandlers.map((h) => () => h(workspaceId, userId)),
    );
  }

  onSessionsRevoked(handler: (userId: string) => Promise<void>): void {
    this.sessionHandlers.push(handler);
  }

  sessionsRevoked(userId: string): Promise<void> {
    return this.run(
      'sessionsRevoked',
      this.sessionHandlers.map((h) => () => h(userId)),
    );
  }

  onPasswordReset(handler: (userId: string) => Promise<void>): void {
    this.passwordResetHandlers.push(handler);
  }

  /** Only a password reset calls this: sign-out and other session cleanups must not end API tokens. */
  passwordReset(userId: string): Promise<void> {
    return this.run(
      'passwordReset',
      this.passwordResetHandlers.map((h) => () => h(userId)),
    );
  }

  onRoleChanged(handler: MemberRemovedHandler): void {
    this.roleHandlers.push(handler);
  }

  roleChanged(workspaceId: string, userId: string): Promise<void> {
    return this.run(
      'roleChanged',
      this.roleHandlers.map((h) => () => h(workspaceId, userId)),
    );
  }

  onProjectMemberRemoved(handler: ProjectMemberRemovedHandler): void {
    this.projectHandlers.push(handler);
  }

  memberRemoved(workspaceId: string, userId: string): Promise<void> {
    return this.run(
      'memberRemoved',
      this.memberHandlers.map((h) => () => h(workspaceId, userId)),
    );
  }

  projectMemberRemoved(workspaceId: string, projectId: string, userId: string): Promise<void> {
    return this.run(
      'projectMemberRemoved',
      this.projectHandlers.map((h) => () => h(workspaceId, projectId, userId)),
    );
  }

  private async run(event: string, calls: (() => Promise<void>)[]): Promise<void> {
    await Promise.all(calls.map((call, i) => this.runOne(event, i, call)));
  }

  // A slow handler must not hold up a request, so each one gets a deadline. Logs carry names only.
  private async runOne(event: string, index: number, call: () => Promise<void>): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), HANDLER_TIMEOUT_MS);
    });
    try {
      const outcome = await Promise.race([(async () => call())(), timeout]);
      if (outcome === 'timeout') {
        this.log.error(`${event} handler ${index} timed out after ${HANDLER_TIMEOUT_MS} ms`);
      }
    } catch (err) {
      this.log.error(`${event} handler ${index} failed: ${describeError(err)}`);
    } finally {
      clearTimeout(timer);
    }
  }
}
