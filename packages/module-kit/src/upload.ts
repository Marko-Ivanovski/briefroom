import {
  BadRequestException,
  createParamDecorator,
  PayloadTooLargeException,
  type ExecutionContext,
} from '@nestjs/common';
import type { IncomingMessage } from 'node:http';

export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

/** Bytes kept draining after a refusal, so the client can finish sending and read the 413. */
const DRAIN_BYTES = 2 * 1024 * 1024;

const TOO_LARGE = `The upload is over ${MAX_UPLOAD_BYTES / 1024 / 1024} MB`;

/** Reads the body on first call. Call it only after the handler's own checks pass. */
export type UploadReader = () => Promise<Buffer>;

async function drain(req: IncomingMessage, already: number): Promise<void> {
  let seen = already;
  try {
    for await (const chunk of req as AsyncIterable<Buffer>) {
      seen += chunk.length;
      if (seen > MAX_UPLOAD_BYTES + DRAIN_BYTES) break;
    }
  } catch {
    // The client went away. The 413 is still the right answer.
  }
}

/**
 * The raw request body, up to 20 MB. The API parses JSON only, so any other content type reaches
 * the handler unread. The type is never trusted: the file store decides it from the bytes.
 */
export async function readUpload(req: IncomingMessage): Promise<Buffer> {
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > MAX_UPLOAD_BYTES) {
    await drain(req, 0);
    throw new PayloadTooLargeException(TOO_LARGE);
  }
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of req as AsyncIterable<Buffer>) {
      size += chunk.length;
      if (size > MAX_UPLOAD_BYTES) {
        await drain(req, size);
        throw new PayloadTooLargeException(TOO_LARGE);
      }
      chunks.push(chunk);
    }
  } catch (err) {
    if (err instanceof PayloadTooLargeException) throw err;
    throw new BadRequestException({
      code: 'upload_aborted',
      message: 'The upload was interrupted',
    });
  }
  return Buffer.concat(chunks);
}

/**
 * Lazy on purpose: the handler checks permission and the target first, so a caller who may not
 * upload never makes the server buffer 20 MB.
 */
export const UploadBody = createParamDecorator(
  (_data: unknown, context: ExecutionContext): UploadReader => {
    const req = context.switchToHttp().getRequest<IncomingMessage>();
    let reading: Promise<Buffer> | undefined;
    return () => (reading ??= readUpload(req));
  },
);
