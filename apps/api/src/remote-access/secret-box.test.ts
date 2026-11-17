import { describe, expect, it } from 'vitest';
import { deriveSecretBoxKey, open, seal } from './secret-box.ts';

const key = deriveSecretBoxKey('x'.repeat(43));

function tamper(sealed: string, part: number): string {
  const parts = sealed.split('.');
  const bytes = Buffer.from(parts[part]!, 'base64url');
  bytes[0] = bytes[0]! ^ 1;
  parts[part] = bytes.toString('base64url');
  return parts.join('.');
}

describe('secret box', () => {
  it('opens what it sealed', () => {
    const plain = 'tskey-auth-kABC123CNTRL-0123456789abcdef';
    expect(open(seal(plain, key), key)).toBe(plain);
  });

  it('writes a versioned value that does not contain the plaintext', () => {
    const sealed = seal('cloudflare-token', key);
    expect(sealed.startsWith('v1.')).toBe(true);
    expect(sealed).not.toContain('cloudflare-token');
  });

  it('uses a fresh IV each time', () => {
    expect(seal('same', key)).not.toBe(seal('same', key));
  });

  it.each([1, 2, 3])('throws when part %i of the sealed value is tampered with', (part) => {
    expect(() => open(tamper(seal('secret', key), part), key)).toThrow();
  });

  it('throws with the wrong key', () => {
    expect(() => open(seal('secret', key), deriveSecretBoxKey('y'.repeat(43)))).toThrow();
  });

  it('throws on an unknown version or a malformed value', () => {
    const sealed = seal('secret', key);
    expect(() => open(sealed.replace(/^v1\./, 'v2.'), key)).toThrow();
    expect(() => open('v1.abc', key)).toThrow();
    expect(() => open('', key)).toThrow();
  });

  it('derives a 32-byte key that differs from the raw env bytes', () => {
    const raw = 'z'.repeat(32);
    const derived = deriveSecretBoxKey(raw);
    expect(derived).toHaveLength(32);
    expect(derived.equals(Buffer.from(raw))).toBe(false);
    expect(deriveSecretBoxKey(raw).equals(derived)).toBe(true);
  });
});
