import {
  createParamDecorator,
  PayloadTooLargeException,
  type ExecutionContext,
} from '@nestjs/common';
import type { IncomingMessage } from 'node:http';

export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

/** Bytes kept draining after a refusal, so the client can finish sending and read the 413. */
const DRAIN_BYTES = 2 * 1024 * 1024;

const TOO_LARGE = `The upload is over ${MAX_UPLOAD_BYTES / 1024 / 1024} MB`;

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
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_UPLOAD_BYTES) {
      await drain(req, size);
      throw new PayloadTooLargeException(TOO_LARGE);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export const UploadBytes = createParamDecorator((_data: unknown, context: ExecutionContext) =>
  readUpload(context.switchToHttp().getRequest<IncomingMessage>()),
);
