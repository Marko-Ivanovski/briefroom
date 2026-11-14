import { describe, expect, it } from 'vitest';
import { canViewProject, roleAtLeast, type Role, type Scope } from './scope.ts';

describe('canViewProject', () => {
  const base = { ...({} as Scope) };
  const scope = (visibleProjectIds: Scope['visibleProjectIds']): Scope => ({
    ...base,
    visibleProjectIds,
  });

  it('allows everything for all, only listed ids otherwise', () => {
    expect(canViewProject(scope('all'), 'p1')).toBe(true);
    expect(canViewProject(scope(['p1']), 'p1')).toBe(true);
    expect(canViewProject(scope(['p1']), 'p2')).toBe(false);
    expect(canViewProject(scope([]), 'p1')).toBe(false);
  });
});

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
