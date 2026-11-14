import type { ChecklistKind } from '@briefroom/contracts';
import { queryOptions, type QueryClient } from '@tanstack/react-query';
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

export const bookmarksQuery = queryOptions({
  queryKey: ['bookmarks'],
  queryFn: api.bookmarks,
  staleTime: 30_000,
});

export const membersQuery = (workspaceId: string) =>
  queryOptions({
    queryKey: ['workspaces', workspaceId, 'members'],
    queryFn: () => api.members(workspaceId),
  });

export const invitesQuery = (workspaceId: string) =>
  queryOptions({
    queryKey: ['workspaces', workspaceId, 'invites'],
    queryFn: () => api.invites(workspaceId),
  });

export const joinRequestsQuery = (workspaceId: string) =>
  queryOptions({
    queryKey: ['workspaces', workspaceId, 'join-requests'],
    queryFn: () => api.joinRequests(workspaceId),
  });

export const joinLookupQuery = (token: string) =>
  queryOptions({
    queryKey: ['join', token],
    queryFn: () => api.joinLookup(token),
  });

const projectsKey = (workspaceId: string) => ['workspaces', workspaceId, 'projects'] as const;

export const settingsQuery = (workspaceId: string) =>
  queryOptions({
    queryKey: ['workspaces', workspaceId, 'settings'],
    queryFn: () => api.settings(workspaceId),
  });

export const projectsQuery = (workspaceId: string) =>
  queryOptions({
    queryKey: projectsKey(workspaceId),
    queryFn: () => api.projects(workspaceId),
  });

export const projectQuery = (workspaceId: string, projectId: string) =>
  queryOptions({
    queryKey: [...projectsKey(workspaceId), projectId],
    queryFn: () => api.project(workspaceId, projectId),
  });

export const projectMembersQuery = (workspaceId: string, projectId: string) =>
  queryOptions({
    queryKey: [...projectsKey(workspaceId), projectId, 'members'],
    queryFn: () => api.projectMembers(workspaceId, projectId),
  });

export const pendingRemovalsQuery = (workspaceId: string, projectId: string) =>
  queryOptions({
    queryKey: [...projectsKey(workspaceId), projectId, 'pending-removals'],
    queryFn: () => api.pendingRemovals(workspaceId, projectId),
  });

export const checklistQuery = (
  workspaceId: string,
  projectId: string,
  userId: string,
  kind: ChecklistKind,
) =>
  queryOptions({
    queryKey: [...projectsKey(workspaceId), projectId, 'checklist', userId, kind],
    queryFn: () => api.checklist(workspaceId, projectId, userId, kind),
  });

// Every project query shares this prefix, so one call refreshes lists, details, members and checklists.
export const invalidateProjects = (queryClient: QueryClient, workspaceId: string) =>
  queryClient.invalidateQueries({ queryKey: projectsKey(workspaceId) });
