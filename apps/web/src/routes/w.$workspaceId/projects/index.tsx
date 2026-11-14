import {
  Button,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@briefroom/ui';
import { useQuery } from '@tanstack/react-query';
import { createFileRoute, Link } from '@tanstack/react-router';
import { projectsQuery, settingsQuery } from '../../../api/queries.ts';
import { useIsAdmin } from '../../../lib/roles.ts';

export const Route = createFileRoute('/w/$workspaceId/projects/')({
  loader: async ({ context: { queryClient }, params }) => {
    await Promise.all([
      queryClient.query(projectsQuery(params.workspaceId)),
      queryClient.query(settingsQuery(params.workspaceId)),
    ]);
  },
  component: ProjectsPage,
});

function ProjectsPage() {
  const { workspaceId } = Route.useParams();
  const { data: projects = [] } = useQuery(projectsQuery(workspaceId));
  const { data: settings } = useQuery(settingsQuery(workspaceId));
  const canCreate = useIsAdmin(workspaceId) || settings?.membersCanCreateProjects === true;

  return (
    <section>
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Projects</h1>
        {canCreate ? (
          <Button asChild>
            <Link to="/w/$workspaceId/projects/new" params={{ workspaceId }}>
              New project
            </Link>
          </Button>
        ) : null}
      </div>
      {projects.length === 0 ? (
        <p className="text-muted-foreground text-sm">No projects yet.</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Client</TableHead>
              <TableHead>Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {projects.map((p) => (
              <TableRow key={p.id}>
                <TableCell>
                  <Link
                    to="/w/$workspaceId/projects/$projectId"
                    params={{ workspaceId, projectId: p.id }}
                    className="underline"
                  >
                    {p.name}
                  </Link>
                </TableCell>
                <TableCell>{p.client ?? ''}</TableCell>
                <TableCell className="capitalize">{p.status}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </section>
  );
}
