import { projects, scoped, scopedInsert, scopedProjects, type Db } from '@briefroom/db';
import {
  CurrentScope,
  DB,
  hasPermission,
  ModuleController,
  type Scope,
} from '@briefroom/module-kit';
import {
  BadRequestException,
  Body,
  ForbiddenException,
  Get,
  Inject,
  NotFoundException,
  Post,
} from '@nestjs/common';
import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { testkitNotes } from '../schema/notes.ts';

const NoteInput = z.object({ text: z.string().min(1).max(500), projectId: z.uuid().optional() });

type Note = typeof testkitNotes.$inferSelect;

@ModuleController('testkit', 'notes')
export class NotesController {
  constructor(@Inject(DB) private readonly db: Db) {}

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
    const [row] = await this.db
      .insert(testkitNotes)
      .values(scopedInsert(scope, parsed.data))
      .returning();
    return row!;
  }
}
