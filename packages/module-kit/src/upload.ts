import {
  BadRequestException,
  createParamDecorator,
  PayloadTooLargeException,
  RequestTimeoutException,
  type ExecutionContext,
} from '@nestjs/common';
import type { IncomingMessage, ServerResponse } from 'node:http';

export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

/** Bytes kept consuming after a refusal, so the client can finish sending and read the 413. */
const DRAIN_BYTES = 2 * 1024 * 1024;

/** How long a refused connection stays readable so the client can receive the answer. */
const CLOSE_GRACE_MS = 200;

const TOO_LARGE = `The upload is over ${MAX_UPLOAD_BYTES / 1024 / 1024} MB`;

export interface UploadLimits {
  /** Longest silence between two chunks. */
  idleMs: number;
  /** Longest the whole body may take. */
  totalMs: number;
}

export const DEFAULT_UPLOAD_LIMITS: UploadLimits = { idleMs: 15_000, totalMs: 60_000 };

/**
 * Reads the body on first call. Call it only after the handler's own checks pass. `declaredBytes`
 * is the Content-Length the client announced, if any, so a caller can reserve memory before reading.
 */
export interface UploadReader {
  (limits?: UploadLimits): Promise<Buffer>;
  readonly declaredBytes: number | undefined;
}

function declaredLength(req: IncomingMessage): number | undefined {
  const raw = req.headers['content-length'];
  const n = raw === undefined ? NaN : Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : undefined;
}

const timedOut = () =>
  new RequestTimeoutException({ code: 'upload_timeout', message: 'The upload took too long' });

/**
 * The raw request body, up to 20 MB, within an idle and a total time limit so a slow client cannot
 * hold a reader for long. The API parses JSON only, so any other content type reaches the handler
 * unread. The type is never trusted: the file store decides it from the bytes.
 *
 * With a Content-Length the body is read into one buffer of that size, not collected and copied.
 * A timeout or a cutoff answers with `Connection: close` and drops the socket once the answer is
 * sent, so a client that keeps trickling cannot keep it open.
 */
export function readUpload(
  req: IncomingMessage,
  limits: UploadLimits = DEFAULT_UPLOAD_LIMITS,
  res?: ServerResponse,
): Promise<Buffer> {
  const aborted = () =>
    new BadRequestException({ code: 'upload_aborted', message: 'The upload was interrupted' });
  if (req.destroyed) return Promise.reject(aborted());
  if (req.readableEnded) return Promise.resolve(Buffer.alloc(0));

  return new Promise<Buffer>((resolve, reject) => {
    const declared = declaredLength(req);
    let over = declared !== undefined && declared > MAX_UPLOAD_BYTES;
    const exact =
      declared !== undefined && declared > 0 && declared <= MAX_UPLOAD_BYTES
        ? Buffer.allocUnsafe(declared)
        : undefined;
    const chunks: Buffer[] = [];
    let size = 0;
    const closeAfterResponse = () => {
      if (!res) return;
      res.setHeader('Connection', 'close');
      // Destroying the socket at once, with the client still sending, makes the OS reset the
      // connection, and on Windows the reset can discard the answer before the client reads it.
      res.once('finish', () => {
        req.resume();
        // FIN first, so the answer is delivered in order before the socket is torn down.
        req.socket.end();
        setTimeout(() => req.destroy(), CLOSE_GRACE_MS).unref();
      });
    };
    const refuse = (error: Error) => {
      closeAfterResponse();
      reject(error);
    };
    let settled = false;
    let idle: NodeJS.Timeout | undefined;

    const settle = (finish: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(idle);
      clearTimeout(total);
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
      req.off('close', onClose);
      finish();
    };
    const armIdle = () => {
      clearTimeout(idle);
      idle = setTimeout(() => settle(() => refuse(timedOut())), limits.idleMs);
    };
    const total = setTimeout(() => settle(() => refuse(timedOut())), limits.totalMs);

    function onData(chunk: Buffer) {
      armIdle();
      const before = size;
      size += chunk.length;
      if (size > MAX_UPLOAD_BYTES || (exact && size > exact.length)) over = true;
      if (over) {
        chunks.length = 0;
        if (size > MAX_UPLOAD_BYTES + DRAIN_BYTES) {
          settle(() => refuse(new PayloadTooLargeException(TOO_LARGE)));
        }
        return;
      }
      if (exact) chunk.copy(exact, before);
      else chunks.push(chunk);
    }
    function onEnd() {
      settle(() =>
        over
          ? reject(new PayloadTooLargeException(TOO_LARGE))
          : resolve(exact ? exact.subarray(0, size) : Buffer.concat(chunks)),
      );
    }
    function onError() {
      settle(() => reject(aborted()));
    }
    function onClose() {
      settle(() => reject(aborted()));
    }

    armIdle();
    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
    req.on('close', onClose);
  });
}

/**
 * Lazy on purpose: the handler checks permission and the target first, so a caller who may not
 * upload never makes the server buffer 20 MB.
 */
export const UploadBody = createParamDecorator(
  (_data: unknown, context: ExecutionContext): UploadReader => {
    const http = context.switchToHttp();
    const req = http.getRequest<IncomingMessage>();
    const res = http.getResponse<ServerResponse>();
    let reading: Promise<Buffer> | undefined;
    const read = (limits?: UploadLimits) => (reading ??= readUpload(req, limits, res));
    return Object.assign(read, { declaredBytes: declaredLength(req) });
  },
);
