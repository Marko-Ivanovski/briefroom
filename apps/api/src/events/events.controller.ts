import type { IncomingMessage, ServerResponse } from 'node:http';
import { Controller, Get, HttpException, HttpStatus, Logger, Req, Res } from '@nestjs/common';
import type { Scope } from '../access/scope.ts';
import { CurrentScope } from '../access/workspace-scope.guard.ts';
import { EventsListener } from './events-listener.ts';
import { STREAM_EPOCH } from './stream-epoch.middleware.ts';
import { StreamRegistry } from './stream-registry.ts';

class TooManyStreamsException extends HttpException {
  constructor() {
    super(
      { code: 'too_many_streams', message: 'Too many open event streams for this workspace' },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}

class EventsUnavailableException extends HttpException {
  constructor() {
    super(
      { code: 'events_unavailable', message: 'Live events are unavailable, try again shortly' },
      HttpStatus.SERVICE_UNAVAILABLE,
    );
  }
}

@Controller('v1/workspaces/:workspaceId/events')
export class EventsController {
  private readonly log = new Logger(EventsController.name);

  constructor(
    private readonly streams: StreamRegistry,
    private readonly listener: EventsListener,
  ) {}

  // A raw response instead of @Sse: the headers, the byte-based backpressure and the closing from
  // closeFor are the contract here, and the cookie session has already been checked by the global guard.
  @Get()
  stream(
    @CurrentScope() scope: Scope,
    @Req() req: IncomingMessage,
    @Res() res: ServerResponse,
  ): void {
    // Without its LISTEN connection the process would accept a stream that can never hear anything.
    if (!this.listener.isUp()) throw new EventsUnavailableException();
    const stream = this.streams.open(
      {
        workspaceId: scope.workspaceId,
        userId: scope.userId,
        visibleProjectIds: scope.visibleProjectIds,
      },
      res,
    );
    if (!stream) throw new TooManyStreamsException();
    // The client may have left while the guards ran: no 'close' event will follow for this stream.
    if (res.destroyed || req.socket.destroyed) {
      stream.close(true);
      return;
    }

    // R130: only the socket idle timeout can cut a quiet stream. requestTimeout covers receiving the
    // request, which is done once a GET's headers are in, so the route needs no opt-out from it.
    req.socket.setTimeout(0);
    req.socket.setNoDelay(true);
    req.socket.setKeepAlive(true);
    res.on('close', () => stream.close());
    res.on('error', () => stream.close());
    // The socket is destroyed after the stream closes, so it must never carry another request.
    res.shouldKeepAlive = false;
    res.writeHead(200, {
      Connection: 'close',
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      'X-Accel-Buffering': 'no',
    });
    res.write(': open\n\n');
    // R135: a revocation between the scope read and the open must not leave this stream behind.
    const epoch = (req as unknown as Record<symbol, number | undefined>)[STREAM_EPOCH];
    if (epoch === undefined) {
      // Fail closed: without the epoch a racing revocation cannot be ruled out.
      this.log.error('A stream request carried no revocation epoch: closing it');
      stream.close();
    } else if (this.streams.revokedSince(epoch, scope.workspaceId, scope.userId)) {
      stream.close();
    }
  }
}
