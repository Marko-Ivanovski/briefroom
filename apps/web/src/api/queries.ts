import { queryOptions } from '@tanstack/react-query';
import { api, ApiError } from './client.ts';

export const setupStatusQuery = queryOptions({
  queryKey: ['setup-status'],
  queryFn: api.setupStatus,
  staleTime: 0,
});

// A 401 is the normal answer for a visitor with no session, so it resolves to null.
export const meQuery = queryOptions({
  queryKey: ['me'],
  queryFn: async () => {
    try {
      return await api.me();
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) return null;
      throw err;
    }
  },
  staleTime: 30_000,
});

export const workspacesQuery = queryOptions({
  queryKey: ['workspaces'],
  queryFn: api.workspaces,
  staleTime: 30_000,
});

export const membersQuery = (workspaceId: string) =>
  queryOptions({
    queryKey: ['workspaces', workspaceId, 'members'],
    queryFn: () => api.members(workspaceId),
  });
