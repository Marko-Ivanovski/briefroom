import { Button } from '@briefroom/ui';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { createFileRoute, redirect, useNavigate } from '@tanstack/react-router';
import { useState, type FormEvent } from 'react';
import { api } from '../api/client.ts';
import { setupStatusQuery } from '../api/queries.ts';
import { AuthCard } from '../components/auth-card.tsx';
import { Field } from '../components/field.tsx';
import { FormError } from '../components/form-error.tsx';
import { messageFor } from '../lib/errors.ts';
import { writeLastWorkspace } from '../lib/last-workspace.ts';

export const Route = createFileRoute('/setup')({
  beforeLoad: async ({ context: { queryClient } }) => {
    const { needsSetup } = await queryClient.query(setupStatusQuery);
    if (!needsSetup) throw redirect({ to: '/' });
  },
  component: SetupPage,
});

function SetupPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  const setup = useMutation({
    mutationFn: api.setup,
    onSuccess: async ({ workspaceId }) => {
      queryClient.clear();
      writeLastWorkspace(workspaceId);
      await navigate({ to: '/w/$workspaceId', params: { workspaceId } });
    },
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    setup.mutate({ code: code.trim(), name, email, password });
  }

  return (
    <AuthCard title="Set up Briefroom">
      <form onSubmit={submit} className="grid gap-4">
        <p className="text-muted-foreground text-sm">
          Enter the setup code printed in the server log, then create the owner account.
        </p>
        <Field
          id="code"
          label="Setup code"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          autoComplete="off"
          required
        />
        <Field
          id="name"
          label="Name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          autoComplete="name"
          required
        />
        <Field
          id="email"
          label="Email"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          autoComplete="email"
          required
        />
        <Field
          id="password"
          label="Password"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="new-password"
          minLength={12}
          maxLength={128}
          required
        />
        <p className="text-muted-foreground -mt-2 text-xs">At least 12 characters.</p>
        <FormError
          message={
            setup.isError
              ? messageFor(setup.error, {
                  400: 'Check the details. The password needs at least 12 characters.',
                  401: 'That setup code is wrong.',
                  410: 'Setup is already done.',
                  429: 'Too many wrong setup codes. Restart Briefroom to get a new code.',
                })
              : null
          }
        />
        <Button type="submit" disabled={setup.isPending}>
          Create workspace
        </Button>
      </form>
    </AuthCard>
  );
}
