import { useMutation, useQueryClient } from '@tanstack/react-query';
import { createFileRoute, redirect, useNavigate } from '@tanstack/react-router';
import { api } from '../../../api/client.ts';
import { invalidateProjects, settingsQuery, workspacesQuery } from '../../../api/queries.ts';
import { ProjectForm, type ProjectFormValues } from '../../../components/project-form.tsx';
import { messageFor, PROJECT_ERRORS } from '../../../lib/errors.ts';
import { isAdminRole } from '../../../lib/roles.ts';

export const Route = createFileRoute('/w/$workspaceId/projects/new')({
  loader: async ({ context: { queryClient }, params }) => {
    const [workspaces, settings] = await Promise.all([
      queryClient.query(workspacesQuery),
      queryClient.query(settingsQuery(params.workspaceId)),
    ]);
    const role = workspaces.find((w) => w.id === params.workspaceId)?.role;
    if (!isAdminRole(role) && !settings.membersCanCreateProjects) {
      throw redirect({ to: '/w/$workspaceId/projects', params });
    }
  },
  component: NewProjectPage,
});

function NewProjectPage() {
  const { workspaceId } = Route.useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const create = useMutation({
    mutationFn: (v: ProjectFormValues) =>
      api.createProject(workspaceId, {
        name: v.name,
        client: v.client,
        summary: v.summary,
        status: 'active',
        isClientWork: false,
        repoRemotes: v.repoRemotes,
        toolLinks: v.toolLinks,
      }),
    onSuccess: async (project) => {
      await invalidateProjects(queryClient, workspaceId);
      await navigate({
        to: '/w/$workspaceId/projects/$projectId',
        params: { workspaceId, projectId: project.id },
      });
    },
  });

  return (
    <section>
      <h1 className="mb-4 text-2xl font-semibold">New project</h1>
      <ProjectForm
        submitLabel="Create project"
        pending={create.isPending}
        error={
          create.error
            ? messageFor(create.error, {
                ...PROJECT_ERRORS,
                400: 'Check the project details and try again.',
                409: 'This repo remote is already registered in this workspace.',
              })
            : null
        }
        onSubmit={(v) => create.mutate(v)}
      />
    </section>
  );
}
