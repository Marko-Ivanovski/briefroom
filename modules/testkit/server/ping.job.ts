import { scoped, scopedUpdate, type Db } from '@briefroom/db';
import { DB, EVENTS, OnJob, type EventPublisher, type JobContext } from '@briefroom/module-kit';
import { Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { testkitNotes } from '../schema/notes.ts';

@Injectable()
export class PingJob {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(EVENTS) private readonly events: EventPublisher,
  ) {}

  @OnJob('testkit.ping')
  async ping({ payload, scope }: JobContext<{ noteId: string }>): Promise<void> {
    await this.db
      .update(testkitNotes)
      .set(scopedUpdate(scope, { text: 'pong' }))
      .where(and(scoped(scope, testkitNotes), eq(testkitNotes.id, payload.noteId)));
    await this.events.publish(scope, {
      type: 'testkit.pinged',
      payload: { noteId: payload.noteId },
    });
  }
}
