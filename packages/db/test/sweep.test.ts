import { afterEach, describe, expect, it, vi } from 'vitest';
import { sweepStaleTestDbs } from '../src/testing.ts';

describe('sweepStaleTestDbs', () => {
  const original = process.env.DATABASE_URL;

  afterEach(() => {
    if (original === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = original;
    vi.restoreAllMocks();
  });

  it('resolves to 0 and warns once when postgres is unreachable', async () => {
    process.env.DATABASE_URL = 'postgres://briefroom:briefroom@127.0.0.1:1/briefroom_dev';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(sweepStaleTestDbs()).resolves.toBe(0);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
