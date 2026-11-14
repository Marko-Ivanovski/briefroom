import { MutationCache, QueryCache, QueryClient } from '@tanstack/react-query';
import { ApiError } from '../api/client.ts';
import { isModulesQuery } from '../api/queries.ts';

interface QueryClientOptions {
  onSessionEnd(): void;
}

export function createQueryClient({ onSessionEnd }: QueryClientOptions): QueryClient {
  // A module answered "off" while the cached list still said on, so the list is stale. Queries and
  // mutations can both hit a module route.
  const refreshOnModuleOff = (error: unknown) => {
    if (error instanceof ApiError && error.status === 409 && error.code === 'module_off') {
      void client.invalidateQueries({ predicate: isModulesQuery });
    }
  };

  const client: QueryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
    queryCache: new QueryCache({
      onError: (error) => {
        // A 401 from a data query means the session ended (expired, revoked or reset), so nothing
        // cached for that user may stay on screen.
        if (error instanceof ApiError && error.status === 401) {
          client.clear();
          onSessionEnd();
        }
        refreshOnModuleOff(error);
      },
    }),
    mutationCache: new MutationCache({ onError: refreshOnModuleOff }),
  });
  return client;
}
