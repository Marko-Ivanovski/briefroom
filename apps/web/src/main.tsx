import { QueryClientProvider } from '@tanstack/react-query';
import { createRouter, RouterProvider } from '@tanstack/react-router';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createQueryClient } from './lib/query-client.ts';
import { mountModuleRoutes } from './module-routes.tsx';
import { routeTree } from './routeTree.gen.ts';
import { Route as workspaceRoute } from './routes/w.$workspaceId/route.tsx';
import './styles.css';

const queryClient = createQueryClient({
  onSessionEnd: () => void router.navigate({ to: '/sign-in' }),
});

mountModuleRoutes(workspaceRoute);

const router = createRouter({
  routeTree,
  context: { queryClient },
  defaultPreloadStaleTime: 0,
  Wrap: ({ children }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  ),
});

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root element');

createRoot(root).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
