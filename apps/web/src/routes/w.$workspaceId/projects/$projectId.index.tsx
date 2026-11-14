import { Button } from '@briefroom/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useState, type ReactNode } from 'react';
import { api } from '../../../api/client.ts';
import {
  invalidateProjects,
  meQuery,
  projectMembersQuery,
  projectQuery,
} from '../../../api/queries.ts';
import { FormError } from '../../../components/form-error.tsx';
import { ProjectForm, type ProjectFormValues } from '../../../components/project-form.tsx';
import { messageFor, PROJECT_ERRORS, PROJECT_FORM_CODES } from '../../../lib/errors.ts';
import { useIsAdmin } from '../../../lib/roles.ts';

export const Route = createFileRoute('/w/$workspaceId/projects/$projectId/')({
  loader: ({ context: { queryClient }, params }) =>
    queryClient.query({
      ...projectMembersQuery(params.workspaceId, params.projectId),
      staleTime: 'static',
    }),
  component: ProjectOverview,
});

function ProjectOverview() {
  const { workspaceId, projectId } = Route.useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const isAdmin = useIsAdmin(workspaceId);
  const { data: project, error: loadError } = useQuery(projectQuery(workspaceId, projectId));
  const { data: members = [] } = useQuery(projectMembersQuery(workspaceId, projectId));
  const { data: me } = useQuery(meQuery);
  const [editing, setEditing] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const goToList = () => navigate({ to: '/w/$workspaceId/projects', params: { workspaceId } });

  const update = useMutation({
    mutationFn: (v: ProjectFormValues) =>
      api.updateProject(workspaceId, projectId, {
        name: v.name,
        client: v.client,
        summary: v.summary,
        repoRemotes: v.repoRemotes,
        toolLinks: v.toolLinks,
      }),
    onSuccess: async () => {
      await invalidateProjects(queryClient, workspaceId);
      setEditing(false);
    },
  });

  // Navigate first: invalidating while still on the project would refetch a project that is gone.
  const remove = useMutation({
    mutationFn: () => api.deleteProject(workspaceId, projectId),
    onSuccess: async () => {
      await goToList();
      await invalidateProjects(queryClient, workspaceId);
    },
  });

  const leave = useMutation({
    mutationFn: () => api.leaveProject(workspaceId, projectId),
    onSuccess: async () => {
      await goToList();
      await invalidateProjects(queryClient, workspaceId);
    },
  });

  if (loadError) {
    return (
      <p role="alert" className="text-destructive text-sm">
        {messageFor(loadError, PROJECT_ERRORS)}
      </p>
    );
  }
  if (!project) return null;
  const onProject = members.some((m) => m.userId === me?.userId);
  const actionError = remove.error ?? leave.error;

  if (editing) {
    return (
      <ProjectForm
        initial={{
          name: project.name,
          client: project.client ?? '',
          summary: project.summary ?? '',
          repoRemotes: project.repoRemotes.map((r) => r.original),
          toolLinks: project.toolLinks.map((l) => ({ label: l.label, url: l.url })),
        }}
        submitLabel="Save changes"
        pending={update.isPending}
        error={update.error ? messageFor(update.error, PROJECT_ERRORS, PROJECT_FORM_CODES) : null}
        onSubmit={(v) => update.mutate(v)}
        onCancel={() => setEditing(false)}
      />
    );
  }

  return (
    <div className="grid gap-6">
      <dl className="grid gap-4 text-sm">
        <Detail term="Client">{project.client ?? 'None'}</Detail>
        <Detail term="Summary">{project.summary ?? 'None'}</Detail>
        <Detail term="Status">
          <span className="capitalize">{project.status}</span>
        </Detail>
        <Detail term="Repo remotes">
          {project.repoRemotes.length === 0 ? (
            'None'
          ) : (
            <ul>
              {project.repoRemotes.map((r) => (
                <li key={r.normalized} className="font-mono">
                  {r.original}
                </li>
              ))}
            </ul>
          )}
        </Detail>
        <Detail term="Tool links">
          {project.toolLinks.length === 0 ? (
            'None'
          ) : (
            <ul>
              {project.toolLinks.map((l) => (
                <li key={l.id}>
                  <a href={l.url} target="_blank" rel="noopener noreferrer" className="underline">
                    {l.label}
                  </a>
                </li>
              ))}
            </ul>
          )}
        </Detail>
      </dl>

      <FormError message={actionError ? messageFor(actionError, PROJECT_ERRORS) : null} />
      <div className="flex flex-wrap gap-2">
        {isAdmin ? (
          <Button variant="outline" onClick={() => setEditing(true)}>
            Edit project
          </Button>
        ) : null}
        {onProject ? (
          <Button variant="outline" disabled={leave.isPending} onClick={() => leave.mutate()}>
            Leave project
          </Button>
        ) : null}
        {isAdmin && !confirmingDelete ? (
          <Button variant="outline" onClick={() => setConfirmingDelete(true)}>
            Delete project
          </Button>
        ) : null}
      </div>
      {isAdmin && confirmingDelete ? (
        <div role="group" aria-label="Confirm delete" className="flex items-center gap-3 text-sm">
          <span>Delete this project and its access records?</span>
          <Button variant="destructive" disabled={remove.isPending} onClick={() => remove.mutate()}>
            Confirm delete
          </Button>
          <Button variant="ghost" onClick={() => setConfirmingDelete(false)}>
            Cancel
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function Detail({ term, children }: { term: string; children: ReactNode }) {
  return (
    <div className="grid gap-1">
      <dt className="text-muted-foreground">{term}</dt>
      <dd>{children}</dd>
    </div>
  );
}
