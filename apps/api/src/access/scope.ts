import type { Role } from '@briefroom/contracts';
import type { Scope } from '@briefroom/module-kit';

export type { Role, Scope };

const RANK: Record<Role, number> = { member: 0, admin: 1, owner: 2 };

export function canViewProject(scope: Scope, projectId: string): boolean {
  return scope.visibleProjectIds === 'all' || scope.visibleProjectIds.includes(projectId);
}

export function roleAtLeast(scope: Scope, min: Role): boolean {
  return RANK[scope.role] >= RANK[min];
}
