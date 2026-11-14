import { createRootRoute, createRoute } from '@tanstack/react-router';
import type { ModuleWebEntry } from '@briefroom/module-kit/web';

// Placeholder parent: the app re-parents module routes under its own root when it mounts them.
const root = createRootRoute();

const notesRoute = createRoute({
  getParentRoute: () => root,
  path: '/w/$workspaceId/m/testkit',
  component: () => <p>Testkit notes</p>,
});

export const testkitWeb: ModuleWebEntry = {
  id: 'testkit',
  routes: [notesRoute],
  nav: [{ label: 'Testkit', to: '/w/$workspaceId/m/testkit' }],
};
