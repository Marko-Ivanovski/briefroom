import { useQuery } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { workspacesQuery } from '../../api/queries.ts';

export const Route = createFileRoute('/w/$workspaceId/')({
  component: WorkspaceHome,
});

function WorkspaceHome() {
  const { workspaceId } = Route.useParams();
  const { data: workspaces = [] } = useQuery(workspacesQuery);
  const name = workspaces.find((w) => w.id === workspaceId)?.name;
  return <h1 className="text-2xl font-semibold">{name}</h1>;
}
