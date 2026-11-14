import { Button } from '@briefroom/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createFileRoute, Link, Outlet, redirect, useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { api } from '../../api/client.ts';
import { FormError } from '../../components/form-error.tsx';
import { meQuery, workspacesQuery } from '../../api/queries.ts';
import { WorkspaceSwitcher } from '../../components/workspace-switcher.tsx';
import { writeLastWorkspace } from '../../lib/last-workspace.ts';

export const Route = createFileRoute('/w/$workspaceId')({
  beforeLoad: async ({ context: { queryClient }, params }) => {
    if (!(await queryClient.query(meQuery))) throw redirect({ to: '/sign-in' });
    const workspaces = await queryClient.query(workspacesQuery);
    if (!workspaces.some((w) => w.id === params.workspaceId)) throw redirect({ to: '/' });
    writeLastWorkspace(params.workspaceId);
  },
  component: WorkspaceLayout,
});

function WorkspaceLayout() {
  const { workspaceId } = Route.useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data: me } = useQuery(meQuery);
  const { data: workspaces = [] } = useQuery(workspacesQuery);

  const [signOutFailed, setSignOutFailed] = useState(false);

  async function signOut() {
    setSignOutFailed(false);
    try {
      await api.signOut();
    } catch {
      setSignOutFailed(true);
      return;
    }
    queryClient.clear();
    await navigate({ to: '/sign-in' });
  }

  return (
    <div className="min-h-screen">
      <header className="flex items-center gap-4 border-b px-4 py-3">
        <WorkspaceSwitcher
          workspaces={workspaces}
          currentId={workspaceId}
          isInstallOwner={me?.isInstallOwner ?? false}
        />
        <nav aria-label="Workspace" className="flex gap-4 text-sm">
          <Link
            to="/w/$workspaceId/settings/members"
            params={{ workspaceId }}
            className="[&.active]:font-semibold"
          >
            Members
          </Link>
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
      </div>
      <main className="mx-auto max-w-3xl p-6">
        <Outlet />
      </main>
    </div>
  );
}
