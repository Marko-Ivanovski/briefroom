import type { Role } from '@briefroom/contracts';
import { useQuery } from '@tanstack/react-query';
import { workspacesQuery } from '../api/queries.ts';

export const isAdminRole = (role: Role | undefined): boolean =>
  role === 'owner' || role === 'admin';

export function useIsAdmin(workspaceId: string): boolean {
  const { data: workspaces = [] } = useQuery(workspacesQuery);
  return isAdminRole(workspaces.find((w) => w.id === workspaceId)?.role);
}
