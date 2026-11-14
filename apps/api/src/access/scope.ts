import type { Role } from '@briefroom/contracts';
import type { Actor } from '@briefroom/db';

export type { Role };

export interface Scope {
  userId: string;
  workspaceId: string;
  role: Role;
  visibleProjectIds: 'all' | string[];
  /** Keys look like `<moduleId>:<key>`. */
  permissions: ReadonlySet<string>;
  actor: Actor;
}

const RANK: Record<Role, number> = { member: 0, admin: 1, owner: 2 };

export function canViewProject(scope: Scope, projectId: string): boolean {
  return scope.visibleProjectIds === 'all' || scope.visibleProjectIds.includes(projectId);
}

export function roleAtLeast(scope: Scope, min: Role): boolean {
  return RANK[scope.role] >= RANK[min];
}
