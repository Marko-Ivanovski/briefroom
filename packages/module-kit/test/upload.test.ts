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

  it('answers 408 upload_timeout when no bytes arrive within the idle time', async () => {
    const stalled = new Readable({ read() {} });
    stalled.push(Buffer.alloc(5, 1));
    await expect(
      readUpload(asRequest(stalled), { idleMs: 50, totalMs: 5000 }),
    ).rejects.toMatchObject({ status: 408, response: { code: 'upload_timeout' } });
  });

  it('answers 408 upload_timeout when a trickle runs past the total deadline', async () => {
    const trickle = new Readable({ read() {} });
    const timer = setInterval(() => trickle.push(Buffer.alloc(1, 1)), 20);
    try {
      await expect(
        readUpload(asRequest(trickle), { idleMs: 1000, totalMs: 150 }),
      ).rejects.toMatchObject({ status: 408, response: { code: 'upload_timeout' } });
    } finally {
      clearInterval(timer);
    }
  });

  it('reads a small body', async () => {
    const body = await readUpload(asRequest(Readable.from([Buffer.from('ab'), Buffer.from('c')])));
    expect(body.toString()).toBe('abc');
  });
});
