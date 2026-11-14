import {
  projects,
  scoped,
  scopedInsert,
  scopedProjects,
  scopedUpdate,
  type Db,
} from '@briefroom/db';
import {
  CurrentScope,
  DB,
  EVENTS,
  HISTORY,
  hasPermission,
  ModuleController,
  type EventPublisher,
  type HistoryRecorder,
  type Scope,
} from '@briefroom/module-kit';
import {
  BadRequestException,
  Body,
  ForbiddenException,
  Get,
  Inject,
  NotFoundException,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { testkitNotes } from '../schema/notes.ts';

const NoteInput = z.object({ text: z.string().min(1).max(500), projectId: z.uuid().optional() });
const NoteEdit = z.object({ text: z.string().min(1).max(500) });

type Note = typeof testkitNotes.$inferSelect;

@ModuleController('testkit', 'notes')
export class NotesController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(HISTORY) private readonly history: HistoryRecorder,
    @Inject(EVENTS) private readonly events: EventPublisher,
  ) {}

  @Get()
  list(@CurrentScope() scope: Scope): Promise<Note[]> {
    return this.db
      .select()
      .from(testkitNotes)
      .where(scoped(scope, testkitNotes))
      .orderBy(desc(testkitNotes.createdAt));
  }

  @Post()
  async create(@CurrentScope() scope: Scope, @Body() body: unknown): Promise<Note> {
    if (!hasPermission(scope, 'testkit', 'write-notes')) throw new ForbiddenException();
    const parsed = NoteInput.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException('text is required, up to 500 characters, projectId a uuid');
    }
    if (parsed.data.projectId) {
      const [visible] = await this.db
        .select({ id: projects.id })
        .from(projects)
        .where(and(scopedProjects(scope), eq(projects.id, parsed.data.projectId)));
      if (!visible) throw new NotFoundException('Project not found');
    }
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .insert(testkitNotes)
        .values(scopedInsert(scope, parsed.data))
        .returning();
      await this.history.record(tx, {
        scope,
        table: 'testkit_notes',
        recordId: row!.id,
        projectId: row!.projectId,
        before: null,
        after: row!,
      });
      await this.events.publish(
        scope,
        {
          type: 'testkit.note_created',
          ...(row!.projectId ? { projectId: row!.projectId } : {}),
          payload: { noteId: row!.id },
        },
        tx,
      );
      return row!;
    });
  }

  @Patch(':noteId')
  async edit(
    @CurrentScope() scope: Scope,
    @Param('noteId') noteId: string,
    @Body() body: unknown,
  ): Promise<Note> {
    if (!hasPermission(scope, 'testkit', 'write-notes')) throw new ForbiddenException();
    const id = z.uuid().safeParse(noteId);
    if (!id.success) throw new NotFoundException('Note not found');
    const parsed = NoteEdit.safeParse(body);
    if (!parsed.success) throw new BadRequestException('text is required, up to 500 characters');
    return this.db.transaction(async (tx) => {
      // scoped() hides a note on a project the caller cannot see, so it reads as missing.
      const [before] = await tx
        .select()
        .from(testkitNotes)
        .where(and(scoped(scope, testkitNotes), eq(testkitNotes.id, id.data)))
        .for('update');
      if (!before) throw new NotFoundException('Note not found');
      const [after] = await tx
        .update(testkitNotes)
        .set(scopedUpdate(scope, { text: parsed.data.text }))
        .where(eq(testkitNotes.id, before.id))
        .returning();
      await this.history.record(tx, {
        scope,
        table: 'testkit_notes',
        recordId: before.id,
        projectId: before.projectId,
        before,
        after: after!,
      });
      return after!;
    });
  }
}
