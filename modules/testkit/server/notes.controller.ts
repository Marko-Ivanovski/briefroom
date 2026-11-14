import { scoped, scopedInsert, type Db } from '@briefroom/db';
import { CurrentScope, DB, ModuleController, type Scope } from '@briefroom/module-kit';
import { BadRequestException, Body, Get, Inject, Post } from '@nestjs/common';
import { desc } from 'drizzle-orm';
import { z } from 'zod';
import { testkitNotes } from '../schema/notes.ts';

const NoteInput = z.object({ text: z.string().min(1).max(500) });

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
    const parsed = NoteInput.safeParse(body);
    if (!parsed.success) throw new BadRequestException('text is required, up to 500 characters');
    const [row] = await this.db
      .insert(testkitNotes)
      .values(scopedInsert(scope, parsed.data))
      .returning();
    return row!;
  }
}
