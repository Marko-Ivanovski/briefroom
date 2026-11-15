import { authSchema, scoped, type Db } from '@briefroom/db';
import {
  DB,
  framedReference,
  ModuleTool,
  toolScope,
  USAGE,
  type ModuleToolContext,
  type UsageLogger,
} from '@briefroom/module-kit';
import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { testkitNotes } from '../schema/notes.ts';

const MAX_NOTES = 50;

const ListInput = z.object({
  projectId: z.uuid().optional(),
  limit: z.number().int().min(1).max(MAX_NOTES).optional(),
});

@Injectable()
export class NotesTools {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(USAGE) private readonly usage: UsageLogger,
  ) {}

  @ModuleTool('testkit', {
    name: 'testkit_list_notes',
    description:
      'The testkit notes you can see, newest first, each with who last changed it and when. Returns at most 50 (or `limit`). Pass projectId to narrow to one project.',
    inputSchema: ListInput,
    readOnly: true,
  })
  async listNotes(input: z.infer<typeof ListInput>, ctx: ModuleToolContext): Promise<string> {
    const scope = toolScope(ctx);
    const limit = input.limit ?? MAX_NOTES;
    const filters: SQL[] = [scoped(scope, testkitNotes)];
    if (input.projectId) filters.push(eq(testkitNotes.projectId, input.projectId));
    const rows = await this.db
      .select({
        id: testkitNotes.id,
        projectId: testkitNotes.projectId,
        text: testkitNotes.text,
        by: authSchema.user.name,
        via: testkitNotes.updatedVia,
        agent: testkitNotes.updatedAgent,
        at: testkitNotes.updatedAt,
      })
      .from(testkitNotes)
      .leftJoin(authSchema.user, eq(authSchema.user.id, testkitNotes.updatedBy))
      .where(and(...filters))
      .orderBy(desc(testkitNotes.updatedAt))
      .limit(limit + 1);
    const truncated = rows.length > limit;
    await this.usage.log(scope, { tool: 'testkit_list_notes' });
    const body = framedReference(`Briefroom testkit notes in workspace ${scope.workspaceId}`, {
      notes: rows.slice(0, limit).map(({ id, projectId, text, by, via, agent, at }) => ({
        id,
        projectId,
        text,
        origin: { by: by ?? null, via, agent, at },
      })),
    });
    return truncated
      ? `${body}

Showing ${limit} of more notes. Pass projectId or a smaller scope to see the rest.`
      : body;
  }
}
