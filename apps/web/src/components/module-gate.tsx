import { useQuery } from '@tanstack/react-query';
import { Outlet } from '@tanstack/react-router';
import { modulesQuery } from '../api/queries.ts';
import { MODULE_OFF_MESSAGE } from '../lib/errors.ts';

interface ModuleGateProps {
  workspaceId: string;
  moduleId: string;
}

export function ModuleGate({ workspaceId, moduleId }: ModuleGateProps) {
  const { data: modules } = useQuery(modulesQuery(workspaceId));
  if (!modules) return null;
  if (!modules.some((m) => m.id === moduleId && m.enabled)) return <p>{MODULE_OFF_MESSAGE}</p>;
  return <Outlet />;
}
