import {
  Button,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@briefroom/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createFileRoute, redirect } from '@tanstack/react-router';
import { api } from '../../../api/client.ts';
import {
  invalidateProjects,
  joinRequestsQuery,
  membersQuery,
  workspacesQuery,
} from '../../../api/queries.ts';
import { FormError } from '../../../components/form-error.tsx';
import { JOIN_REQUEST_ERRORS, messageFor } from '../../../lib/errors.ts';
import { isAdminRole } from '../../../lib/roles.ts';

export const Route = createFileRoute('/w/$workspaceId/settings/join-requests')({
  loader: async ({ context: { queryClient }, params }) => {
    const workspaces = await queryClient.query({ ...workspacesQuery, staleTime: 'static' });
    if (!isAdminRole(workspaces.find((w) => w.id === params.workspaceId)?.role)) {
      throw redirect({ to: '/w/$workspaceId', params });
    }
    await queryClient.query({ ...joinRequestsQuery(params.workspaceId), staleTime: 0 });
  },
  component: JoinRequestsPage,
});

function JoinRequestsPage() {
  const { workspaceId } = Route.useParams();
  const queryClient = useQueryClient();
  const { data: requests = [] } = useQuery(joinRequestsQuery(workspaceId));

  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: joinRequestsQuery(workspaceId).queryKey }),
      queryClient.invalidateQueries({ queryKey: membersQuery(workspaceId).queryKey }),
      invalidateProjects(queryClient, workspaceId),
    ]);
  };

  const approve = useMutation({
    mutationFn: (id: string) => api.approveJoinRequest(workspaceId, id),
    onSuccess: refresh,
  });
  const decline = useMutation({
    mutationFn: (id: string) => api.declineJoinRequest(workspaceId, id),
    onSuccess: refresh,
  });
  const busy = approve.isPending || decline.isPending;

  return (
    <section>
      <h1 className="mb-2 text-2xl font-semibold">Join requests</h1>
      <p className="text-muted-foreground mb-4 text-sm">
        Confirm who this is outside Briefroom before you approve. An email that is not verified was
        typed in by the person asking.
      </p>
      <FormError
        message={
          approve.isError
            ? messageFor(approve.error, JOIN_REQUEST_ERRORS)
            : decline.isError
              ? messageFor(decline.error, JOIN_REQUEST_ERRORS)
              : null
        }
      />
      {requests.length === 0 ? (
        <p className="text-muted-foreground text-sm">No requests waiting.</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Email</TableHead>
              <TableHead>Role</TableHead>
              <TableHead>Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {requests.map((r) => (
              <TableRow key={r.id}>
                <TableCell>{r.name}</TableCell>
                <TableCell>
                  {r.email}
                  {r.emailVerified ? null : (
                    <span className="text-muted-foreground block text-xs">
                      self-reported, not verified
                    </span>
                  )}
                </TableCell>
                <TableCell>{r.role === 'admin' ? 'Admin' : 'Member'}</TableCell>
                <TableCell>
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      aria-label={`Approve ${r.name}`}
                      disabled={busy}
                      onClick={() => approve.mutate(r.id)}
                    >
                      Approve
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      aria-label={`Decline ${r.name}`}
                      disabled={busy}
                      onClick={() => decline.mutate(r.id)}
                    >
                      Decline
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </section>
  );
}
