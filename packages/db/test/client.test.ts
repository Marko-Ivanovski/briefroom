import { describe, expect, it, vi } from 'vitest';
import { createDb } from '../src/client.ts';
import { DEV_DATABASE_URL } from '../src/dev-url.ts';

describe('createDb', () => {
  it('logs pool errors instead of crashing the process', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const db = createDb(DEV_DATABASE_URL);
    try {
      expect(() => db.$client.emit('error', new Error('idle client lost'))).not.toThrow();
      expect(log).toHaveBeenCalled();
    } finally {
      log.mockRestore();
      await db.$client.end();
    }
  });
});
