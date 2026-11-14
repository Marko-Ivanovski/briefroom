import { Injectable, type OnModuleInit } from '@nestjs/common';
import { RevocationService } from '../members/revocation.service.ts';
import { StreamRegistry } from './stream-registry.ts';

/** Ends a person's streams the moment their access changes, so the next one gets a fresh snapshot. */
@Injectable()
export class StreamRevocation implements OnModuleInit {
  constructor(
    private readonly revocation: RevocationService,
    private readonly streams: StreamRegistry,
  ) {}

  onModuleInit(): void {
    this.revocation.onMemberRemoved(async (workspaceId, userId) => {
      this.streams.closeFor(workspaceId, userId);
    });
    this.revocation.onProjectMemberRemoved(async (workspaceId, projectId, userId) => {
      this.streams.closeFor(workspaceId, userId, projectId);
    });
    // R134: a new project means a new snapshot, so the reconnect picks it up.
    this.revocation.onProjectMemberAdded(async (workspaceId, userId) => {
      this.streams.closeFor(workspaceId, userId);
    });
    // R136: a stream must not outlive the sessions that authorised it.
    this.revocation.onSessionsRevoked(async (userId) => {
      this.streams.closeUser(userId);
    });
    this.revocation.onRoleChanged(async (workspaceId, userId) => {
      this.streams.closeFor(workspaceId, userId);
    });
  }
}
