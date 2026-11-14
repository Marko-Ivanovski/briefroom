import { describe, expect, it } from 'vitest';
import { loadEnv } from '../src/config/env.ts';

describe('loadEnv', () => {
  it('lists every missing variable in one error', () => {
    expect(() => loadEnv({})).toThrow(/DATABASE_URL is required.*BRIEFROOM_PUBLIC_URL is required/);
  });

  it('defaults PORT to 4300', () => {
    const env = loadEnv({
      DATABASE_URL: 'postgres://x/y',
      BRIEFROOM_PUBLIC_URL: 'http://localhost:4300',
    });
    expect(env.port).toBe(4300);
    expect(env.webDir).toMatch(/web[\\/]dist$/);
  });

  it('rejects an invalid public url', () => {
    expect(() => loadEnv({ DATABASE_URL: 'postgres://x/y', BRIEFROOM_PUBLIC_URL: 'nope' })).toThrow(
      /BRIEFROOM_PUBLIC_URL/,
    );
  });
});
