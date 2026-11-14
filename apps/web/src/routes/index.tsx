import { createFileRoute, redirect } from '@tanstack/react-router';
import { meQuery, setupStatusQuery, workspacesQuery } from '../api/queries.ts';
import { pickWorkspace } from '../lib/last-workspace.ts';

export const Route = createFileRoute('/')({
  beforeLoad: async ({ context: { queryClient } }) => {
    const { needsSetup } = await queryClient.query(setupStatusQuery);
    if (needsSetup) throw redirect({ to: '/setup' });
    if (!(await queryClient.query(meQuery))) throw redirect({ to: '/sign-in' });
    const workspaceId = pickWorkspace(await queryClient.query(workspacesQuery));
    if (workspaceId) throw redirect({ to: '/w/$workspaceId', params: { workspaceId } });
  },
  component: NoWorkspace,
});

function NoWorkspace() {
  return (
    <main className="mx-auto max-w-2xl p-8">
      <h1 className="text-2xl font-semibold">Briefroom</h1>
      <p className="text-muted-foreground mt-2">
        You are not a member of any workspace yet. Ask the owner of this install for access.
      </p>
    </main>
  );
}
