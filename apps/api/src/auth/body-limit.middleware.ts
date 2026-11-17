import type { IncomingMessage, ServerResponse } from 'node:http';

export const JSON_BODY_LIMIT = '1mb';
const LIMIT_BYTES = 1024 * 1024;
const AUTH_PATH = /^\/api\/auth(?:[/?]|$)/;

function refuse(res: ServerResponse, status: number, message: string): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ statusCode: status, message }));
}

/**
 * Nest's body parser enforces JSON_BODY_LIMIT on every JSON route except /api/auth, which Better
 * Auth reads itself with no cap. The declared Content-Length bounds what Node will read, so refusing
 * an oversized one here covers it. A chunked body on that path has no declared size, so it is
 * refused. File uploads are not JSON and keep their own, larger limit.
 */
export function bodyLimitMiddleware(
  req: IncomingMessage,
  res: ServerResponse,
  next: () => void,
): void {
  if (!AUTH_PATH.test(req.url ?? '') && !req.headers['content-type']?.includes('json')) {
    return next();
  }
  const length = req.headers['content-length'];
  if (length !== undefined && Number(length) > LIMIT_BYTES) {
    return refuse(res, 413, 'Payload Too Large');
  }
  if (length === undefined && req.headers['transfer-encoding']) {
    return refuse(res, 411, 'Length Required');
  }
  next();
}
