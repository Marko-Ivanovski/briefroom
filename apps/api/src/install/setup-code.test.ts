import { describe, expect, it } from 'vitest';
import { generateSetupCode, hashSetupCode, setupCodeMatches } from './setup-code.ts';

describe('setup code', () => {
  it('generates XXXX-XXXX in Crockford base32', () => {
    for (let i = 0; i < 200; i++) {
      expect(generateSetupCode()).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
    }
  });

  it('does not repeat', () => {
    const codes = new Set(Array.from({ length: 100 }, generateSetupCode));
    expect(codes.size).toBe(100);
  });

  it('matches its own hash regardless of case, dash and spaces', () => {
    const hash = hashSetupCode('ABCD-2345');
    expect(setupCodeMatches('abcd-2345', hash)).toBe(true);
    expect(setupCodeMatches(' ABCD2345 ', hash)).toBe(true);
    expect(setupCodeMatches('ABCD-2346', hash)).toBe(false);
    expect(setupCodeMatches('', hash)).toBe(false);
  });
});
