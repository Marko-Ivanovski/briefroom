import { createRoute, type AnyRoute } from '@tanstack/react-router';
import type { QueryClient } from '@tanstack/react-query';
import { assertModuleEnabled, ModuleGate, ModuleGateError } from './components/module-gate.tsx';
import { WEB_MODULES } from './modules.ts';

// File routes and code routes meet here. Each module gets one gate route at m/<id> under the
// workspace layout. The module's own routes are written against a placeholder root, so they are
// re-parented onto the gate before the router initialises them.
export function mountModuleRoutes(workspaceRoute: AnyRoute): void {
  const gates = WEB_MODULES.map((entry) => {
    function Gate() {
      const { workspaceId } = workspaceRoute.useParams() as { workspaceId: string };
      return <ModuleGate workspaceId={workspaceId} moduleId={entry.id} />;
    }
    const gate = createRoute({
      getParentRoute: () => workspaceRoute,
      path: `m/${entry.id}`,
      beforeLoad: ({ context, params }: { context: unknown; params: unknown }) =>
        assertModuleEnabled(
          (context as { queryClient: QueryClient }).queryClient,
          (params as { workspaceId: string }).workspaceId,
          entry.id,
        ),
      component: Gate,
      errorComponent: ModuleGateError,
    });
    const children = entry.routes.map((route) =>
      route.update({ getParentRoute: () => gate } as never),
    );
    return gate.addChildren(children);
  });
  const existing = (workspaceRoute.children as AnyRoute[] | undefined) ?? [];
  workspaceRoute.children = [...existing, ...gates];
}
