import { Button } from '@briefroom/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createFileRoute, Link, Outlet, redirect } from '@tanstack/react-router';
import { useState } from 'react';
import { api } from '../../api/client.ts';
import { bookmarksQuery, meQuery, modulesQuery, workspacesQuery } from '../../api/queries.ts';
import { FormError } from '../../components/form-error.tsx';
import { JoinWorkspaceDialog } from '../../components/join-workspace-dialog.tsx';
import { WorkspaceSwitcher } from '../../components/workspace-switcher.tsx';
import { writeLastWorkspace } from '../../lib/last-workspace.ts';
import { BOOKMARK_CODES, BOOKMARK_ERRORS, messageFor } from '../../lib/errors.ts';
import { isAdminRole } from '../../lib/roles.ts';
import { useSignOut } from '../../lib/use-sign-out.ts';
import { WEB_MODULES } from '../../modules.ts';

export const Route = createFileRoute('/w/$workspaceId')({
  beforeLoad: async ({ context: { queryClient }, params }) => {
    if (!(await queryClient.query(meQuery))) throw redirect({ to: '/sign-in' });
    const workspaces = await queryClient.query(workspacesQuery);
    if (!workspaces.some((w) => w.id === params.workspaceId)) throw redirect({ to: '/' });
    writeLastWorkspace(params.workspaceId);
  },
  loader: async ({ context: { queryClient }, params }) => {
    await queryClient.query({ ...modulesQuery(params.workspaceId), staleTime: 'static' });
  },
  component: WorkspaceLayout,
});

function WorkspaceLayout() {
  const { workspaceId } = Route.useParams();
  const { data: me } = useQuery(meQuery);
  const { data: workspaces = [] } = useQuery(workspacesQuery);

  const { data: modules = [] } = useQuery(modulesQuery(workspaceId));
  const enabledIds = new Set(modules.filter((m) => m.enabled).map((m) => m.id));

  const { data: bookmarks = [] } = useQuery(bookmarksQuery);
  const queryClient = useQueryClient();
  const [joining, setJoining] = useState(false);
  const removeBookmark = useMutation({
    mutationFn: api.deleteBookmark,
    onSettled: () => queryClient.invalidateQueries({ queryKey: bookmarksQuery.queryKey }),
  });

  const { signOut, failed: signOutFailed } = useSignOut();

  return (
    <div className="min-h-screen">
      <header className="flex items-center gap-4 border-b px-4 py-3">
        <WorkspaceSwitcher
          workspaces={workspaces}
          currentId={workspaceId}
          isInstallOwner={me?.isInstallOwner ?? false}
          bookmarks={bookmarks}
          onJoin={() => setJoining(true)}
          onRemoveBookmark={(id) => removeBookmark.mutate(id)}
        />
        <JoinWorkspaceDialog open={joining} onClose={() => setJoining(false)} />
        <nav aria-label="Workspace" className="flex gap-4 text-sm">
          <Link
            to="/w/$workspaceId/projects"
            params={{ workspaceId }}
            className="[&.active]:font-semibold"
          >
            Projects
          </Link>
          <Link
            to="/w/$workspaceId/settings/members"
            params={{ workspaceId }}
            className="[&.active]:font-semibold"
          >
            Members
          </Link>
          {WEB_MODULES.filter((w) => enabledIds.has(w.id)).flatMap((w) =>
            w.nav.map((item) => (
              <Link
                key={`${w.id}${item.to}`}
                to={item.to as string}
                params={{ workspaceId }}
                className="[&.active]:font-semibold"
              >
                {item.label}
              </Link>
            )),
          )}
          <Link
            to="/w/$workspaceId/settings/modules"
            params={{ workspaceId }}
            className="[&.active]:font-semibold"
          >
            Modules
          </Link>
          {isAdminRole(workspaces.find((w) => w.id === workspaceId)?.role) ? (
            <>
              <Link
                to="/w/$workspaceId/settings/invites"
                params={{ workspaceId }}
                className="[&.active]:font-semibold"
              >
                Invites
              </Link>
              <Link
                to="/w/$workspaceId/settings/join-requests"
                params={{ workspaceId }}
                className="[&.active]:font-semibold"
              >
                Join requests
              </Link>
            </>
          ) : null}
        </nav>
        <div className="ml-auto flex items-center gap-3 text-sm">
          <span className="text-muted-foreground">{me?.email}</span>
          <Button variant="outline" size="sm" onClick={signOut}>
            Sign out
          </Button>
        </div>
      </header>
      <div className="px-4 pt-3">
        <FormError message={signOutFailed ? 'Something went wrong. Try again.' : null} />
        <FormError
          message={
            removeBookmark.isError
              ? messageFor(removeBookmark.error, BOOKMARK_ERRORS, BOOKMARK_CODES)
              : null
          }
        />
      </div>
      <main className="mx-auto max-w-3xl p-6">
        <Outlet />
      </main>
    </div>
  );
}
