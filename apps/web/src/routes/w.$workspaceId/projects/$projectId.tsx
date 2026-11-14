import { useQuery } from '@tanstack/react-query';
import { createFileRoute, Link, Outlet } from '@tanstack/react-router';
import { projectQuery } from '../../../api/queries.ts';
import { messageFor, PROJECT_ERRORS } from '../../../lib/errors.ts';

export const Route = createFileRoute('/w/$workspaceId/projects/$projectId')({
  loader: ({ context: { queryClient }, params }) =>
    queryClient.query({
      ...projectQuery(params.workspaceId, params.projectId),
      staleTime: 'static',
    }),
  errorComponent: ({ error }) => <ProjectError error={error} />,
  component: ProjectLayout,
});

function ProjectError({ error }: { error: unknown }) {
  return (
    <p role="alert" className="text-destructive text-sm">
      {messageFor(error, PROJECT_ERRORS)}
    </p>
  );
}

function ProjectLayout() {
  const { workspaceId, projectId } = Route.useParams();
  const { data: project, error } = useQuery(projectQuery(workspaceId, projectId));
  // A refetch that fails (access lost, project deleted) keeps the cached project in `data`.
  if (error) return <ProjectError error={error} />;
  return (
    <section>
      <h1 className="text-2xl font-semibold">{project?.name}</h1>
      <nav aria-label="Project" className="mt-3 mb-6 flex gap-4 border-b pb-2 text-sm">
        <Link
          to="/w/$workspaceId/projects/$projectId"
          params={{ workspaceId, projectId }}
          activeOptions={{ exact: true }}
          className="[&.active]:font-semibold"
        >
          Overview
        </Link>
        <Link
          to="/w/$workspaceId/projects/$projectId/members"
          params={{ workspaceId, projectId }}
          className="[&.active]:font-semibold"
        >
          Project members
        </Link>
      </nav>
      <Outlet />
    </section>
  );
}
