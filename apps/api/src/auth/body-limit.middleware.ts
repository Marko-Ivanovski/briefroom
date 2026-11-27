import type { IncomingMessage, ServerResponse } from 'node:http';

export const JSON_BODY_LIMIT = '1mb';
const LIMIT_BYTES = 1024 * 1024;
const AUTH_PATH = /^\/api\/auth(?:[/?]|$)/;

function refuse(res: ServerResponse): void {
  res.on('error', () => undefined);
  res.statusCode = 413;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Connection', 'close');
  res.end(JSON.stringify({ statusCode: 413, message: 'Payload Too Large' }));
}

/**
 * Nest's body parser enforces JSON_BODY_LIMIT on every route except /api/auth, which Better Auth
 * reads itself with no cap, so this caps that path. A declared Content-Length is checked up front.
 * A body with no declared length (chunked, as HTTP/2 clients behind a proxy can send) is counted as
 * it arrives, by wrapping the stream's push, so the handler still reads it untouched.
 */
export function bodyLimitMiddleware(
  req: IncomingMessage,
  res: ServerResponse,
  next: () => void,
): void {
  if (!AUTH_PATH.test(req.url ?? '')) return next();

  const length = req.headers['content-length'];
  if (length !== undefined) {
    if (Number(length) > LIMIT_BYTES) return refuse(res);
    return next();
  }

  let received = 0;
  let refused = false;
  const push = req.push.bind(req);
  req.push = (chunk: unknown, encoding?: BufferEncoding): boolean => {
    if (refused) return false;
    received +=
      typeof chunk === 'string'
        ? Buffer.byteLength(chunk)
        : ((chunk as Buffer | null)?.length ?? 0);
    if (received > LIMIT_BYTES) {
      refused = true;
      refuse(res);
      return false;
    }
    return push(chunk as Buffer | null, encoding);
  };
  next();
}
