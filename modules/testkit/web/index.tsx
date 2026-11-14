import { createRootRoute, createRoute, lazyRouteComponent } from '@tanstack/react-router';
import type { ModuleWebEntry } from '@briefroom/module-kit/web';
import { TestkitSettingsPanel } from './settings-panel.tsx';

// Placeholder parent: the app mounts the routes under /w/$workspaceId/m/<module id>.
const root = createRootRoute();

const notesRoute = createRoute({
  getParentRoute: () => root,
  path: '/',
  component: lazyRouteComponent(() => import('./notes-page.tsx')),
});

export const testkitWeb: ModuleWebEntry = {
  id: 'testkit',
  routes: [notesRoute],
  nav: [{ label: 'Testkit', to: '/w/$workspaceId/m/testkit' }],
  settingsPanel: TestkitSettingsPanel,
};
