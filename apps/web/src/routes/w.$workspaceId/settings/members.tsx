import type { Role } from '@briefroom/contracts';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@briefroom/ui';
import { useQuery } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { membersQuery } from '../../../api/queries.ts';

const ROLE_LABELS: Record<Role, string> = { owner: 'Owner', admin: 'Admin', member: 'Member' };

export const Route = createFileRoute('/w/$workspaceId/settings/members')({
  loader: ({ context: { queryClient }, params }) =>
    queryClient.query({ ...membersQuery(params.workspaceId), staleTime: 0 }),
  component: MembersPage,
});

function MembersPage() {
  const { workspaceId } = Route.useParams();
  const { data: members = [] } = useQuery(membersQuery(workspaceId));
  return (
    <section>
      <h1 className="mb-4 text-2xl font-semibold">Members</h1>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead>Email</TableHead>
            <TableHead>Role</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {members.map((m) => (
            <TableRow key={m.userId}>
              <TableCell>{m.name}</TableCell>
              <TableCell>{m.email}</TableCell>
              <TableCell>{ROLE_LABELS[m.role]}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </section>
  );
}
