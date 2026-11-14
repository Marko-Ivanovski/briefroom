import { Injectable, Logger } from '@nestjs/common';
import { describeError } from '../errors/safe-error.ts';

export type MemberRemovedHandler = (workspaceId: string, userId: string) => Promise<void>;
export type ProjectMemberRemovedHandler = (
  workspaceId: string,
  projectId: string,
  userId: string,
) => Promise<void>;

/**
 * Registry for things that must stop at once when access ends: API tokens (Task 7.1) and live
 * streams (Task 6.4) register handlers here. One failing handler never blocks the others.
 */
@Injectable()
export class RevocationService {
  private readonly log = new Logger(RevocationService.name);
  private readonly memberHandlers: MemberRemovedHandler[] = [];
  private readonly projectHandlers: ProjectMemberRemovedHandler[] = [];

  onMemberRemoved(handler: MemberRemovedHandler): void {
    this.memberHandlers.push(handler);
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
    const results = await Promise.allSettled(calls.map(async (call) => call()));
    for (const r of results) {
      if (r.status === 'rejected') {
        this.log.error(`${event} handler failed: ${describeError(r.reason)}`);
      }
    }
  }
}
