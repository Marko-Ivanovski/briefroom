import { describe, expect, it } from 'vitest';
import { normaliseAddress, request } from '../src/api.ts';
import { testContext } from './helpers.ts';

describe('normaliseAddress', () => {
  it('turns a bare host into https and drops the trailing slash', () => {
    expect(normaliseAddress('briefroom.example.com')).toBe('https://briefroom.example.com');
    expect(normaliseAddress('https://Briefroom.Example.com/')).toBe(
      'https://briefroom.example.com',
    );
  });

  it('drops the default port and keeps a path prefix', () => {
    expect(normaliseAddress('https://example.com:443')).toBe('https://example.com');
    expect(normaliseAddress('https://example.com:8443/brf/')).toBe('https://example.com:8443/brf');
  });

  it('refuses plain http to a remote host, naming https', () => {
    expect(() => normaliseAddress('http://example.com')).toThrow(/https:\/\/example\.com/);
    expect(() => normaliseAddress('http://10.0.0.5:4300')).toThrow('plain http');
    expect(() => normaliseAddress('http://127.0.0.1.evil.example')).toThrow('plain http');
  });

  it('allows http for localhost, 127.0.0.0/8 and ::1', () => {
    expect(normaliseAddress('http://localhost:4300')).toBe('http://localhost:4300');
    expect(normaliseAddress('http://app.localhost:4300')).toBe('http://app.localhost:4300');
    expect(normaliseAddress('http://127.0.0.1:4300')).toBe('http://127.0.0.1:4300');
    expect(normaliseAddress('http://127.5.5.5')).toBe('http://127.5.5.5');
    expect(normaliseAddress('http://[::1]:4300')).toBe('http://[::1]:4300');
  });

  it('refuses other schemes', () => {
    expect(() => normaliseAddress('ftp://example.com')).toThrow();
  });
});

describe('request', () => {
  it('refuses to send anything over plain http to a remote host, even from a saved entry', async () => {
    const t = await testContext({
      fetch: () => Promise.reject(new Error('must not be called')),
    });
    await expect(request(t.ctx, 'http://example.com', '/x')).rejects.toThrow('plain http');
    await t.cleanup();
  });
});
