import {
  BadRequestException,
  createParamDecorator,
  PayloadTooLargeException,
  RequestTimeoutException,
  type ExecutionContext,
} from '@nestjs/common';
import type { IncomingMessage } from 'node:http';

export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

/** Bytes kept consuming after a refusal, so the client can finish sending and read the 413. */
const DRAIN_BYTES = 2 * 1024 * 1024;

const TOO_LARGE = `The upload is over ${MAX_UPLOAD_BYTES / 1024 / 1024} MB`;

export interface UploadLimits {
  /** Longest silence between two chunks. */
  idleMs: number;
  /** Longest the whole body may take. */
  totalMs: number;
}

export const DEFAULT_UPLOAD_LIMITS: UploadLimits = { idleMs: 15_000, totalMs: 60_000 };

/** Reads the body on first call. Call it only after the handler's own checks pass. */
export type UploadReader = (limits?: UploadLimits) => Promise<Buffer>;

const timedOut = () =>
  new RequestTimeoutException({ code: 'upload_timeout', message: 'The upload took too long' });

/**
 * The raw request body, up to 20 MB, within an idle and a total time limit so a slow client cannot
 * hold a reader for long. The API parses JSON only, so any other content type reaches the handler
 * unread. The type is never trusted: the file store decides it from the bytes.
 */
export function readUpload(
  req: IncomingMessage,
  limits: UploadLimits = DEFAULT_UPLOAD_LIMITS,
): Promise<Buffer> {
  const aborted = () =>
    new BadRequestException({ code: 'upload_aborted', message: 'The upload was interrupted' });
  if (req.destroyed) return Promise.reject(aborted());
  if (req.readableEnded) return Promise.resolve(Buffer.alloc(0));

  return new Promise<Buffer>((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    let over = Number.isFinite(declared) && declared > MAX_UPLOAD_BYTES;
    const chunks: Buffer[] = [];
    let size = 0;
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
      idle = setTimeout(() => settle(() => reject(timedOut())), limits.idleMs);
    };
    const total = setTimeout(() => settle(() => reject(timedOut())), limits.totalMs);

    function onData(chunk: Buffer) {
      armIdle();
      size += chunk.length;
      if (size > MAX_UPLOAD_BYTES) over = true;
      if (over) {
        chunks.length = 0;
        if (size > MAX_UPLOAD_BYTES + DRAIN_BYTES) {
          settle(() => reject(new PayloadTooLargeException(TOO_LARGE)));
        }
        return;
      }
      chunks.push(chunk);
    }
    function onEnd() {
      settle(() =>
        over ? reject(new PayloadTooLargeException(TOO_LARGE)) : resolve(Buffer.concat(chunks)),
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
    const req = context.switchToHttp().getRequest<IncomingMessage>();
    let reading: Promise<Buffer> | undefined;
    return (limits) => (reading ??= readUpload(req, limits));
  },
);
