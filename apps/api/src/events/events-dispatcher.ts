import { MODULE_STATE, type ModuleState } from '@briefroom/module-kit';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { z } from 'zod';
import { describeError } from '../errors/safe-error.ts';
import type { WorkspaceEvent } from './events.service.ts';
import { StreamRegistry } from './stream-registry.ts';

const Envelope = z.object({
  workspaceId: z.string().min(1),
  projectId: z.string().optional(),
  type: z.string().min(1),
  payload: z.unknown(),
});

/** Fans each notification out to the open streams of this process, in the order it arrived. */
@Injectable()
export class EventsDispatcher {
  private readonly log = new Logger(EventsDispatcher.name);
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly streams: StreamRegistry,
    @Inject(MODULE_STATE) private readonly modules: ModuleState,
  ) {}

  dispatch(raw: string | undefined): void {
    this.queue = this.queue
      .then(() => this.deliver(raw))
      .catch((err: unknown) => {
        this.log.error(`Dropping an event: ${describeError(err)}`);
      });
  }

  private async deliver(raw: string | undefined): Promise<void> {
    const event = this.parse(raw);
    if (!event || this.streams.streamsOf(event.workspaceId).length === 0) return;

    // Module-off is checked once per event, not once per subscriber (R122).
    const moduleId = event.type.slice(0, event.type.indexOf('.'));
    if (moduleId !== 'core' && !(await this.modules.isEnabled(event.workspaceId, moduleId))) return;

    const frame = `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
    // Read again after the await, so a stream that closed meanwhile is skipped.
    for (const stream of this.streams.streamsOf(event.workspaceId)) {
      if (stream.canSee(event.projectId)) stream.send(frame);
    }
  }

  private parse(raw: string | undefined): WorkspaceEvent | undefined {
    try {
      const parsed = Envelope.safeParse(JSON.parse(raw ?? ''));
      if (parsed.success && parsed.data.type.includes('.') && !/[\r\n]/.test(parsed.data.type)) {
        return parsed.data as WorkspaceEvent;
      }
    } catch {
      // not JSON
    }
    this.log.warn('Dropping a malformed event notification');
    return undefined;
  }
}
