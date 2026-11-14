import { QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createRouter, RouterProvider } from '@tanstack/react-router';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ApiError } from './api/client.ts';
import { isModulesQuery } from './api/queries.ts';
import { mountModuleRoutes } from './module-routes.tsx';
import { routeTree } from './routeTree.gen.ts';
import { Route as workspaceRoute } from './routes/w.$workspaceId/route.tsx';
import './styles.css';

// A 401 from a data query means the session ended (expired, revoked or reset), so nothing cached
// for that user may stay on screen.
const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false } },
  queryCache: new QueryCache({
    onError: (error) => {
      if (error instanceof ApiError && error.status === 401) {
        queryClient.clear();
        void router.navigate({ to: '/sign-in' });
      }
      // A module answered "off" while the cached list still said on, so the list is stale.
      if (error instanceof ApiError && error.status === 409 && error.code === 'module_off') {
        void queryClient.invalidateQueries({ predicate: isModulesQuery });
      }
    },
  }),
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
