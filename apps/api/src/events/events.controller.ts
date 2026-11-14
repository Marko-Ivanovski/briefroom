import type { IncomingMessage, ServerResponse } from 'node:http';
import { Controller, Get, HttpException, HttpStatus, Req, Res } from '@nestjs/common';
import type { Scope } from '../access/scope.ts';
import { CurrentScope } from '../access/workspace-scope.guard.ts';
import { StreamRegistry } from './stream-registry.ts';

class TooManyStreamsException extends HttpException {
  constructor() {
    super(
      { code: 'too_many_streams', message: 'Too many open event streams for this workspace' },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}

@Controller('v1/workspaces/:workspaceId/events')
export class EventsController {
  constructor(private readonly streams: StreamRegistry) {}

  // A raw response instead of @Sse: the headers, the byte-based backpressure and the closing from
  // closeFor are the contract here, and the cookie session has already been checked by the global guard.
  @Get()
  stream(
    @CurrentScope() scope: Scope,
    @Req() req: IncomingMessage,
    @Res() res: ServerResponse,
  ): void {
    const stream = this.streams.open(
      {
        workspaceId: scope.workspaceId,
        userId: scope.userId,
        visibleProjectIds: scope.visibleProjectIds,
      },
      res,
    );
    if (!stream) throw new TooManyStreamsException();

    // R130: only the socket idle timeout can cut a quiet stream. requestTimeout covers receiving the
    // request, which is done once a GET's headers are in, so the route needs no opt-out from it.
    req.socket.setTimeout(0);
    req.socket.setNoDelay(true);
    req.socket.setKeepAlive(true);
    res.on('close', () => stream.close());
    res.on('error', () => stream.close());
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      'X-Accel-Buffering': 'no',
    });
    res.write(': open\n\n');
  }
}
