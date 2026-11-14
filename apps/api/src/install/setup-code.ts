import { createHash, randomInt, timingSafeEqual } from 'node:crypto';

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export function generateSetupCode(): string {
  const chars = Array.from({ length: 8 }, () => ALPHABET[randomInt(ALPHABET.length)]!);
  return `${chars.slice(0, 4).join('')}-${chars.slice(4).join('')}`;
}

// Crockford base32 reads O as 0 and I or L as 1, so a code typed from a screen still matches.
function normalize(code: string): string {
  return code
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
}

export function hashSetupCode(code: string): string {
  return createHash('sha256').update(normalize(code)).digest('hex');
}

export function setupCodeMatches(candidate: string, storedHash: string): boolean {
  const a = Buffer.from(hashSetupCode(candidate), 'hex');
  const b = Buffer.from(storedHash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}
