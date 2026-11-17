import { DEV_DATABASE_URL } from '@briefroom/db';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DEV_AUTH_SECRET, loadEnv } from '../src/config/env.ts';

const PROD = { NODE_ENV: 'production' };
const BASE = {
  DATABASE_URL: 'postgres://x/y',
  BRIEFROOM_PUBLIC_URL: 'http://localhost:4300',
  BRIEFROOM_DATA_DIR: '/var/lib/briefroom',
};

describe('loadEnv BETTER_AUTH_SECRET', () => {
  const LONG = 'x'.repeat(32);

  it('is required in production', () => {
    expect(() => loadEnv({ ...PROD, ...BASE })).toThrow(/BETTER_AUTH_SECRET is required/);
  });

  it('rejects the dev-only secret in production', () => {
    expect(() => loadEnv({ ...PROD, ...BASE, BETTER_AUTH_SECRET: DEV_AUTH_SECRET })).toThrow(
      /BETTER_AUTH_SECRET: .*dev-only/,
    );
  });

  it('must be at least 32 characters in production', () => {
    expect(() => loadEnv({ ...PROD, ...BASE, BETTER_AUTH_SECRET: 'short' })).toThrow(
      /BETTER_AUTH_SECRET: .*32/,
    );
  });

  it('is used as given in production', () => {
    const env = loadEnv({ ...PROD, ...BASE, BETTER_AUTH_SECRET: LONG });
    expect(env.authSecret).toBe(LONG);
    expect(env.usingDevAuthSecret).toBe(false);
  });

  it('falls back to the dev-only constant outside production', () => {
    const env = loadEnv({});
    expect(env.authSecret).toBe(DEV_AUTH_SECRET);
    expect(env.authSecret).toMatch(/dev-only/);
    expect(env.authSecret.length).toBeGreaterThanOrEqual(32);
    expect(env.usingDevAuthSecret).toBe(true);
  });

  it('treats an empty value as unset outside production', () => {
    expect(loadEnv({ BETTER_AUTH_SECRET: '' }).usingDevAuthSecret).toBe(true);
  });

  it('uses a provided value outside production', () => {
    const env = loadEnv({ BETTER_AUTH_SECRET: 'my-own-secret' });
    expect(env.authSecret).toBe('my-own-secret');
    expect(env.usingDevAuthSecret).toBe(false);
  });
});

describe('loadEnv', () => {
  it('defaults the database url and public url outside production', () => {
    const env = loadEnv({});
    expect(env.databaseUrl).toBe(DEV_DATABASE_URL);
    expect(env.publicUrl).toBe('http://localhost:5173');
    expect(env.host).toBe('127.0.0.1');
  });

  it('lists every missing variable in one error in production', () => {
    expect(() => loadEnv(PROD)).toThrow(
      /DATABASE_URL is required.*BRIEFROOM_PUBLIC_URL is required/,
    );
  });

  it('defaults PORT to 4300', () => {
    const env = loadEnv(BASE);
    expect(env.port).toBe(4300);
    expect(env.webDir).toMatch(/web[\\/]dist$/);
  });

  it('treats empty optional variables as unset', () => {
    const env = loadEnv({ ...BASE, PORT: '', BRIEFROOM_WEB_DIR: '', HOST: '' });
    expect(env.port).toBe(4300);
    expect(env.webDir).toMatch(/web[\\/]dist$/);
    expect(env.host).toBe('127.0.0.1');
  });

  it('treats empty required variables as unset outside production', () => {
    const env = loadEnv({ DATABASE_URL: '', BRIEFROOM_PUBLIC_URL: '' });
    expect(env.databaseUrl).toBe(DEV_DATABASE_URL);
  });

  it.each(['70000', '0', '-1', '1.5', 'abc'])('rejects PORT=%s', (port) => {
    expect(() => loadEnv({ ...BASE, PORT: port })).toThrow(/PORT/);
  });

  it('rejects an invalid public url', () => {
    expect(() => loadEnv({ ...BASE, BRIEFROOM_PUBLIC_URL: 'nope' })).toThrow(
      /BRIEFROOM_PUBLIC_URL/,
    );
  });

  it('rejects a non-http public url', () => {
    expect(() => loadEnv({ ...BASE, BRIEFROOM_PUBLIC_URL: 'ftp://x' })).toThrow(
      /BRIEFROOM_PUBLIC_URL/,
    );
  });

  it('strips a trailing slash from the public url', () => {
    const env = loadEnv({ ...BASE, BRIEFROOM_PUBLIC_URL: 'https://a.example/' });
    expect(env.publicUrl).toBe('https://a.example');
  });
});

describe('loadEnv BRIEFROOM_TESTKIT', () => {
  const SECRET = { BETTER_AUTH_SECRET: 'x'.repeat(32) };

  it('refuses the testkit in production with a clear message', () => {
    expect(() => loadEnv({ ...PROD, ...BASE, ...SECRET, BRIEFROOM_TESTKIT: '1' })).toThrow(
      /BRIEFROOM_TESTKIT: .*production/,
    );
  });

  it('allows the testkit outside production and an unset flag in production', () => {
    expect(() => loadEnv({ ...BASE, BRIEFROOM_TESTKIT: '1' })).not.toThrow();
    expect(() => loadEnv({ ...PROD, ...BASE, ...SECRET })).not.toThrow();
    expect(() => loadEnv({ ...PROD, ...BASE, ...SECRET, BRIEFROOM_TESTKIT: '' })).not.toThrow();
  });
});

describe('loadEnv BRIEFROOM_DATA_DIR', () => {
  const SECRET = { BETTER_AUTH_SECRET: 'x'.repeat(32) };
  const WITHOUT_DIR = {
    DATABASE_URL: BASE.DATABASE_URL,
    BRIEFROOM_PUBLIC_URL: BASE.BRIEFROOM_PUBLIC_URL,
  };

  it('is required in production', () => {
    expect(() => loadEnv({ ...PROD, ...WITHOUT_DIR, ...SECRET })).toThrow(
      /BRIEFROOM_DATA_DIR is required/,
    );
  });

  const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));

  it('defaults to <repo root>/.data, the same from the root and from any app folder', () => {
    const expected = join(REPO_ROOT, '.data');
    expect(loadEnv(WITHOUT_DIR, REPO_ROOT).dataDir).toBe(expected);
    expect(loadEnv(WITHOUT_DIR, join(REPO_ROOT, 'apps', 'worker')).dataDir).toBe(expected);
    expect(loadEnv(WITHOUT_DIR, join(REPO_ROOT, 'apps', 'api')).dataDir).toBe(expected);
  });

  it('refuses to start without a default when no repo root is found', () => {
    expect(() => loadEnv(WITHOUT_DIR, tmpdir())).toThrow(/BRIEFROOM_DATA_DIR.*repo root/);
  });

  it('refuses a relative path', () => {
    expect(() => loadEnv({ ...BASE, BRIEFROOM_DATA_DIR: 'relative/dir' })).toThrow(
      /BRIEFROOM_DATA_DIR: must be an absolute path/,
    );
  });
});

describe('loadEnv BRIEFROOM_TRUSTED_PROXIES', () => {
  const env = (value?: string) =>
    loadEnv({ ...BASE, ...(value === undefined ? {} : { BRIEFROOM_TRUSTED_PROXIES: value }) });

  it('is empty by default', () => {
    expect(env().trustedProxies).toEqual([]);
    expect(env('').trustedProxies).toEqual([]);
  });

  it('reads a comma list of addresses and CIDR ranges', () => {
    expect(env('172.30.0.0/16, 10.0.0.1 ,fd00::/8').trustedProxies).toEqual([
      '172.30.0.0/16',
      '10.0.0.1',
      'fd00::/8',
    ]);
  });

  it.each(['nope', '10.0.0.1/33', '10.0.0.0/', 'fd00::/129', '10.0.0.1,,x'])(
    'rejects %s',
    (value) => {
      expect(() => env(value)).toThrow(/BRIEFROOM_TRUSTED_PROXIES/);
    },
  );
});
