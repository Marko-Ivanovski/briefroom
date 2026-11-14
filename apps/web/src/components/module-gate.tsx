import type { QueryClient } from '@tanstack/react-query';
import { useQuery } from '@tanstack/react-query';
import { Outlet } from '@tanstack/react-router';
import { modulesQuery } from '../api/queries.ts';
import { MODULE_CHECK_FAILED_MESSAGE, MODULE_OFF_MESSAGE } from '../lib/errors.ts';

export class ModuleOffError extends Error {
  constructor() {
    super(MODULE_OFF_MESSAGE);
    this.name = 'ModuleOffError';
  }
}

/**
 * Runs in the gate route's beforeLoad, so a switched-off module's child loaders never start. It
 * reads the cached module list and refetches only when that list is stale.
 */
export async function assertModuleEnabled(
  queryClient: QueryClient,
  workspaceId: string,
  moduleId: string,
): Promise<void> {
  const modules = await queryClient.query(modulesQuery(workspaceId));
  if (!modules.some((m) => m.id === moduleId && m.enabled)) throw new ModuleOffError();
}

/** Shown when the gate's beforeLoad throws: the off notice, or a fixed string if the check failed. */
export function ModuleGateError({ error }: { error: unknown }) {
  return (
    <p>{error instanceof ModuleOffError ? MODULE_OFF_MESSAGE : MODULE_CHECK_FAILED_MESSAGE}</p>
  );
}

interface ModuleGateProps {
  workspaceId: string;
  moduleId: string;
}

/** Keeps the page honest after the gate passed: a refetched list can say the module went off. */
export function ModuleGate({ workspaceId, moduleId }: ModuleGateProps) {
  const { data: modules, isError } = useQuery(modulesQuery(workspaceId));
  if (!modules) return isError ? <p>{MODULE_CHECK_FAILED_MESSAGE}</p> : null;
  if (!modules.some((m) => m.id === moduleId && m.enabled)) return <p>{MODULE_OFF_MESSAGE}</p>;
  return <Outlet />;
}
