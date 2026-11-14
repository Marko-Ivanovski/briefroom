import type { RemovalResult, Role } from '@briefroom/contracts';
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
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { api } from '../../../api/client.ts';
import {
  invalidateProjects,
  meQuery,
  membersQuery,
  workspacesQuery,
} from '../../../api/queries.ts';
import { FormError } from '../../../components/form-error.tsx';
import { MEMBER_CODES, MEMBER_ERRORS, messageFor } from '../../../lib/errors.ts';
import { isAdminRole } from '../../../lib/roles.ts';

const ROLE_LABELS: Record<Role, string> = { owner: 'Owner', admin: 'Admin', member: 'Member' };

export const Route = createFileRoute('/w/$workspaceId/settings/members')({
  loader: async ({ context: { queryClient }, params }) => {
    await Promise.all([
      queryClient.query({ ...membersQuery(params.workspaceId), staleTime: 0 }),
      queryClient.query({ ...workspacesQuery, staleTime: 'static' }),
      queryClient.query({ ...meQuery, staleTime: 'static' }),
    ]);
  },
  component: MembersPage,
});

function MembersPage() {
  const { workspaceId } = Route.useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data: members = [] } = useQuery(membersQuery(workspaceId));
  const { data: workspaces = [] } = useQuery(workspacesQuery);
  const { data: me } = useQuery(meQuery);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [confirmingLeave, setConfirmingLeave] = useState(false);
  const [removed, setRemoved] = useState<{ name: string; projects: RemovalResult['projects'] }>();

  const callerRole = workspaces.find((w) => w.id === workspaceId)?.role;
  const canRemove = (target: { userId: string; role: Role }) =>
    isAdminRole(callerRole) &&
    target.role !== 'owner' &&
    target.userId !== me?.userId &&
    (target.role !== 'admin' || callerRole === 'owner');

  const remove = useMutation({
    mutationFn: (userId: string) => api.removeMember(workspaceId, userId),
    onSuccess: async (result, userId) => {
      setConfirming(null);
      const name = members.find((m) => m.userId === userId)?.name ?? 'This person';
      setRemoved({ name, projects: result.projects });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: membersQuery(workspaceId).queryKey }),
        invalidateProjects(queryClient, workspaceId),
      ]);
    },
  });

  const leave = useMutation({
    mutationFn: () => api.leaveWorkspace(workspaceId),
    onSuccess: async () => {
      queryClient.clear();
      await navigate({ to: '/' });
    },
  });

  return (
    <section>
      <h1 className="mb-4 text-2xl font-semibold">Members</h1>
      <FormError
        message={
          remove.isError
            ? messageFor(remove.error, MEMBER_ERRORS, MEMBER_CODES)
            : leave.isError
              ? messageFor(leave.error, MEMBER_ERRORS, MEMBER_CODES)
              : null
        }
      />
      {removed && removed.projects.length > 0 ? (
        <section aria-label="Pending removals" className="mb-4 rounded-md border p-4 text-sm">
          <p>
            {removed.name} still has access to take away on {removed.projects.length}{' '}
            {removed.projects.length === 1 ? 'project' : 'projects'}:
          </p>
          <ul className="mt-2 grid gap-1">
            {removed.projects.map((p) => (
              <li key={p.id}>
                <Link
                  className="underline"
                  to="/w/$workspaceId/projects/$projectId/members"
                  params={{ workspaceId, projectId: p.id }}
                >
                  {p.name}
                </Link>
                , {p.undone} undone
              </li>
            ))}
          </ul>
        </section>
      ) : null}
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
          {members.map((m) => (
            <TableRow key={m.userId}>
              <TableCell>{m.name}</TableCell>
              <TableCell>{m.email}</TableCell>
              <TableCell>{ROLE_LABELS[m.role]}</TableCell>
              <TableCell>
                {canRemove(m) ? (
                  confirming === m.userId ? (
                    <div
                      role="group"
                      aria-label={`Confirm removing ${m.name}`}
                      className="grid gap-2"
                    >
                      <p className="text-muted-foreground text-xs">
                        Invite links {m.name} created will be revoked, and joining again will need
                        approval.
                      </p>
                      <div className="flex gap-2">
                        <Button
                          variant="destructive"
                          size="sm"
                          aria-label={`Confirm remove ${m.name}`}
                          disabled={remove.isPending}
                          onClick={() => remove.mutate(m.userId)}
                        >
                          Confirm remove
                        </Button>
                        <Button variant="ghost" size="sm" onClick={() => setConfirming(null)}>
                          Cancel
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <Button
                      variant="outline"
                      size="sm"
                      aria-label={`Remove ${m.name}`}
                      onClick={() => setConfirming(m.userId)}
                    >
                      Remove
                    </Button>
                  )
                ) : null}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {callerRole && callerRole !== 'owner' ? (
        <div className="mt-6">
          {confirmingLeave ? (
            <div role="group" aria-label="Confirm leaving the workspace" className="flex gap-2">
              <Button
                variant="destructive"
                size="sm"
                disabled={leave.isPending}
                onClick={() => leave.mutate()}
              >
                Confirm leave
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setConfirmingLeave(false)}>
                Cancel
              </Button>
            </div>
          ) : (
            <Button variant="outline" size="sm" onClick={() => setConfirmingLeave(true)}>
              Leave workspace
            </Button>
          )}
        </div>
      ) : null}
    </section>
  );
}
