import { DEV_DATABASE_URL } from '@briefroom/db';
import { describe, expect, it } from 'vitest';
import { loadEnv } from '../src/config/env.ts';

const PROD = { NODE_ENV: 'production' };
const BASE = { DATABASE_URL: 'postgres://x/y', BRIEFROOM_PUBLIC_URL: 'http://localhost:4300' };

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
