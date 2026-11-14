import { describe, expect, it } from 'vitest';
import { roleAtLeast, type Role, type Scope } from './scope.ts';

function scopeWith(role: Role): Scope {
  return {
    userId: 'u1',
    workspaceId: 'w1',
    role,
    visibleProjectIds: 'all',
    permissions: new Set(),
    actor: { userId: 'u1', via: 'web' },
  };
}

describe('roleAtLeast', () => {
  it.each<[Role, Role, boolean]>([
    ['owner', 'owner', true],
    ['owner', 'admin', true],
    ['owner', 'member', true],
    ['admin', 'owner', false],
    ['admin', 'admin', true],
    ['admin', 'member', true],
    ['member', 'owner', false],
    ['member', 'admin', false],
    ['member', 'member', true],
  ])('%s at least %s is %s', (role, min, expected) => {
    expect(roleAtLeast(scopeWith(role), min)).toBe(expected);
  });
});
