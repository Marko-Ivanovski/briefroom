import { Readable } from 'node:stream';
import type { IncomingMessage } from 'node:http';
import { describe, expect, it } from 'vitest';
import { readUpload } from '../src/index.ts';

const asRequest = (stream: Readable, headers: Record<string, string> = {}) =>
  Object.assign(stream, { headers }) as unknown as IncomingMessage;

describe('readUpload', () => {
  it('answers a clean 400 upload_aborted when the client drops mid-upload', async () => {
    const stream = new Readable({
      read() {
        this.push(Buffer.alloc(10, 1));
        this.destroy(new Error('aborted'));
      },
    });
    await expect(readUpload(asRequest(stream))).rejects.toMatchObject({
      status: 400,
      response: { code: 'upload_aborted' },
    });
  });

  it('reads a small body', async () => {
    const body = await readUpload(asRequest(Readable.from([Buffer.from('ab'), Buffer.from('c')])));
    expect(body.toString()).toBe('abc');
  });
});
