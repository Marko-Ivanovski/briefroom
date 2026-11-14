import type { BookmarkCreated, BookmarkSummary } from '@briefroom/contracts';
import { createdStamp, updatedStamp, workspaceBookmarks, type Actor, type Db } from '@briefroom/db';
import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { DB } from '../database/database.module.ts';
import { fetchRemoteInvite, joinUrlOf, parseInviteUrl } from './remote-host.ts';

const MAX_LABEL = 80;
const uuid = z.uuid();
const notFound = () => new NotFoundException({ code: 'not_found', message: 'Bookmark not found' });

@Injectable()
export class BookmarksService {
  constructor(@Inject(DB) private readonly db: Db) {}

  async create(actor: Actor, inviteUrl: string): Promise<BookmarkCreated> {
    const parsed = parseInviteUrl(inviteUrl);
    const remote = await fetchRemoteInvite(parsed);
    const label = remote.workspaceName.trim().slice(0, MAX_LABEL);
    const [row] = await this.db
      .insert(workspaceBookmarks)
      .values({
        userId: actor.userId,
        label,
        remoteBaseUrl: parsed.base,
        remoteInstallId: remote.installId,
        remoteWorkspaceId: remote.workspaceId,
        ...createdStamp(actor),
      })
      .onConflictDoUpdate({
        target: [
          workspaceBookmarks.userId,
          workspaceBookmarks.remoteInstallId,
          workspaceBookmarks.remoteWorkspaceId,
        ],
        set: { label, remoteBaseUrl: parsed.base, ...updatedStamp(actor) },
      })
      .returning({ id: workspaceBookmarks.id });
    return { id: row!.id, label, joinUrl: joinUrlOf(parsed) };
  }

  async list(userId: string): Promise<BookmarkSummary[]> {
    return this.db
      .select({
        id: workspaceBookmarks.id,
        label: workspaceBookmarks.label,
        remoteBaseUrl: workspaceBookmarks.remoteBaseUrl,
      })
      .from(workspaceBookmarks)
      .where(eq(workspaceBookmarks.userId, userId))
      .orderBy(asc(workspaceBookmarks.createdAt), asc(workspaceBookmarks.id));
  }

  async remove(userId: string, id: string): Promise<void> {
    if (!uuid.safeParse(id).success) throw notFound();
    const deleted = await this.db
      .delete(workspaceBookmarks)
      .where(and(eq(workspaceBookmarks.userId, userId), eq(workspaceBookmarks.id, id)))
      .returning({ id: workspaceBookmarks.id });
    if (deleted.length === 0) throw notFound();
  }
}
