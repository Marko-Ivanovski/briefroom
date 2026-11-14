import type { ChecklistKind } from '@briefroom/contracts';
import {
  Button,
  Label,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@briefroom/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { useState } from 'react';
import { api } from '../../../api/client.ts';
import {
  invalidateProjects,
  membersQuery,
  projectMembersQuery,
  workspacesQuery,
} from '../../../api/queries.ts';
import { AccessChecklist } from '../../../components/access-checklist.tsx';
import { FormError } from '../../../components/form-error.tsx';
import { ADD_MEMBER_CODES, messageFor, PROJECT_ERRORS } from '../../../lib/errors.ts';
import { isAdminRole, useIsAdmin } from '../../../lib/roles.ts';

export const Route = createFileRoute('/w/$workspaceId/projects/$projectId/members')({
  loader: async ({ context: { queryClient }, params }) => {
    const workspaces = await queryClient.query({ ...workspacesQuery, staleTime: 'static' });
    const admin = isAdminRole(workspaces.find((w) => w.id === params.workspaceId)?.role);
    await Promise.all([
      queryClient.query({
        ...projectMembersQuery(params.workspaceId, params.projectId),
        staleTime: 'static',
      }),
      admin
        ? queryClient.query({ ...membersQuery(params.workspaceId), staleTime: 'static' })
        : undefined,
    ]);
  },
  component: ProjectMembersPage,
});

interface OpenChecklist {
  userId: string;
  name: string;
  kind: ChecklistKind;
}

function ProjectMembersPage() {
  const { workspaceId, projectId } = Route.useParams();
  const queryClient = useQueryClient();
  const isAdmin = useIsAdmin(workspaceId);
  const { data: members = [] } = useQuery(projectMembersQuery(workspaceId, projectId));
  const { data: workspaceMembers = [] } = useQuery({
    ...membersQuery(workspaceId),
    enabled: isAdmin,
  });
  const [selected, setSelected] = useState('');
  const [confirmingRemove, setConfirmingRemove] = useState<string | null>(null);
  const [checklist, setChecklist] = useState<OpenChecklist | null>(null);

  const candidates = workspaceMembers.filter((w) => !members.some((m) => m.userId === w.userId));

  const add = useMutation({
    mutationFn: (userId: string) => api.addProjectMember(workspaceId, projectId, userId),
    onSuccess: async (member) => {
      setSelected('');
      setChecklist({ userId: member.userId, name: member.name, kind: 'add' });
      await invalidateProjects(queryClient, workspaceId);
    },
  });

  const remove = useMutation({
    mutationFn: (member: { userId: string; name: string }) =>
      api.removeProjectMember(workspaceId, projectId, member.userId),
    onSuccess: async (_, member) => {
      setConfirmingRemove(null);
      setChecklist({ userId: member.userId, name: member.name, kind: 'remove' });
      await invalidateProjects(queryClient, workspaceId);
    },
  });

  return (
    <div>
      {isAdmin ? (
        <form
          className="mb-6 flex items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (selected) add.mutate(selected);
          }}
        >
          <div className="grid gap-2">
            <Label htmlFor="add-member">Add a member</Label>
            <select
              id="add-member"
              value={selected}
              onChange={(e) => setSelected(e.target.value)}
              className="border-input focus-visible:border-ring focus-visible:ring-ring/50 h-9 min-w-64 rounded-md border bg-transparent px-3 text-sm shadow-xs outline-none focus-visible:ring-[3px]"
            >
              <option value="">Choose a person</option>
              {candidates.map((w) => (
                <option key={w.userId} value={w.userId}>
                  {w.name} ({w.email})
                </option>
              ))}
            </select>
          </div>
          <Button type="submit" disabled={!selected || add.isPending}>
            Add to project
          </Button>
        </form>
      ) : null}
      <FormError
        message={
          add.error
            ? messageFor(add.error, PROJECT_ERRORS, ADD_MEMBER_CODES)
            : remove.error
              ? messageFor(remove.error, PROJECT_ERRORS)
              : null
        }
      />

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead>Email</TableHead>
            {isAdmin ? <TableHead>Actions</TableHead> : null}
          </TableRow>
        </TableHeader>
        <TableBody>
          {members.map((m) => (
            <TableRow key={m.userId}>
              <TableCell>{m.name}</TableCell>
              <TableCell>{m.email}</TableCell>
              {isAdmin ? (
                <TableCell>
                  {confirmingRemove === m.userId ? (
                    <div
                      role="group"
                      aria-label={`Confirm removing ${m.name}`}
                      className="flex gap-2"
                    >
                      <Button
                        variant="destructive"
                        size="sm"
                        aria-label={`Confirm remove ${m.name}`}
                        disabled={remove.isPending}
                        onClick={() => remove.mutate({ userId: m.userId, name: m.name })}
                      >
                        Confirm remove
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => setConfirmingRemove(null)}>
                        Cancel
                      </Button>
                    </div>
                  ) : (
                    <Button
                      variant="outline"
                      size="sm"
                      aria-label={`Remove ${m.name}`}
                      onClick={() => setConfirmingRemove(m.userId)}
                    >
                      Remove
                    </Button>
                  )}
                </TableCell>
              ) : null}
            </TableRow>
          ))}
        </TableBody>
      </Table>

      {isAdmin && checklist ? (
        <AccessChecklist
          key={`${checklist.kind}-${checklist.userId}`}
          workspaceId={workspaceId}
          projectId={projectId}
          userId={checklist.userId}
          name={checklist.name}
          kind={checklist.kind}
          onClose={() => setChecklist(null)}
        />
      ) : null}
    </div>
  );
}
