import { describe, expect, it } from 'vitest';
import { normalizeCliLoginCode } from './cli-login-code.ts';

describe('normalizeCliLoginCode', () => {
  it.each([
    ['ABCD-EFGH', 'ABCD-EFGH'],
    ['abcd-efgh', 'ABCD-EFGH'],
    ['abcdefgh', 'ABCD-EFGH'],
    ['  ab cd-ef gh ', 'ABCD-EFGH'],
    ['ab2d efg9', 'AB2D-EFG9'],
  ])('accepts %j as %s', (input, expected) => {
    expect(normalizeCliLoginCode(input)).toBe(expected);
  });

  it.each(['', 'ABCD', 'ABCD-EFGHJ', 'ABCD-EFG0', 'ABCD-EFGI', 'ABCD_EFGH'])(
    'rejects %j',
    (input) => {
      expect(normalizeCliLoginCode(input)).toBeNull();
    },
  );
});
