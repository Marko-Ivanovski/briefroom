import { Button } from '@briefroom/ui';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useState, type FormEvent } from 'react';
import { api } from '../../api/client.ts';
import { workspacesQuery } from '../../api/queries.ts';
import { Field } from '../../components/field.tsx';
import { FormError } from '../../components/form-error.tsx';
import { messageFor } from '../../lib/errors.ts';

export const Route = createFileRoute('/w/$workspaceId/new-workspace')({
  component: NewWorkspacePage,
});

function NewWorkspacePage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const create = useMutation({
    mutationFn: () => api.createWorkspace(name),
    onSuccess: async ({ id }) => {
      await queryClient.invalidateQueries(workspacesQuery);
      await navigate({ to: '/w/$workspaceId', params: { workspaceId: id } });
    },
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    create.mutate();
  }

  return (
    <section className="max-w-sm">
      <h1 className="mb-4 text-2xl font-semibold">New workspace</h1>
      <form onSubmit={submit} className="grid gap-4">
        <Field
          id="name"
          label="Workspace name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={100}
          required
        />
        <FormError
          message={
            create.isError
              ? messageFor(create.error, { 403: 'Only the install owner can create workspaces.' })
              : null
          }
        />
        <Button type="submit" disabled={create.isPending}>
          Create workspace
        </Button>
      </form>
    </section>
  );
}
