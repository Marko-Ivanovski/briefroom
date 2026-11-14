import type { JoinResult } from '@briefroom/contracts';
import { Button } from '@briefroom/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useState, type FormEvent } from 'react';
import { api } from '../api/client.ts';
import { joinLookupQuery, meQuery } from '../api/queries.ts';
import { AuthCard } from '../components/auth-card.tsx';
import { Field } from '../components/field.tsx';
import { FormError } from '../components/form-error.tsx';
import { JOIN_CODES, JOIN_ERRORS, messageFor } from '../lib/errors.ts';

export const Route = createFileRoute('/join/$token')({
  loader: async ({ context: { queryClient }, params }) => {
    await Promise.all([
      queryClient.query({ ...joinLookupQuery(params.token), staleTime: 0 }),
      queryClient.query({ ...meQuery, staleTime: 0 }),
    ]);
  },
  component: JoinPage,
});

function JoinPage() {
  const { token } = Route.useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data: lookup } = useQuery(joinLookupQuery(token));
  const { data: me } = useQuery(meQuery);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [waiting, setWaiting] = useState(false);

  async function finish(result: JoinResult) {
    queryClient.clear();
    if (result.status === 'pending') {
      setWaiting(true);
      return;
    }
    await navigate({ to: '/w/$workspaceId', params: { workspaceId: result.workspaceId } });
  }

  const signUp = useMutation({
    mutationFn: () => api.joinSignUp(token, { name, email, password }),
    onSuccess: finish,
  });
  const accept = useMutation({
    mutationFn: () => api.joinAccept(token),
    onSuccess: finish,
  });

  if (waiting) {
    return (
      <AuthCard title="Request sent">
        <p role="status" className="text-sm">
          You are waiting for approval. A workspace admin will review your request.
        </p>
      </AuthCard>
    );
  }

  if (!lookup?.valid) {
    return (
      <AuthCard title="Invite link">
        <p className="text-sm">{JOIN_CODES.invite_invalid}</p>
      </AuthCard>
    );
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    signUp.mutate();
  }

  const approvalNote = lookup.requiresApproval
    ? 'An admin has to approve your request before you get in.'
    : null;

  if (me) {
    return (
      <AuthCard title={`Join ${lookup.workspaceName}`}>
        <p className="mb-4 text-sm">
          You are signed in as {me.email}. {approvalNote}
        </p>
        <FormError
          message={accept.isError ? messageFor(accept.error, JOIN_ERRORS, JOIN_CODES) : null}
        />
        <Button disabled={accept.isPending} onClick={() => accept.mutate()}>
          Accept invite
        </Button>
      </AuthCard>
    );
  }

  return (
    <AuthCard title={`Join ${lookup.workspaceName}`}>
      <form onSubmit={submit} className="grid gap-4">
        {approvalNote ? <p className="text-muted-foreground text-sm">{approvalNote}</p> : null}
        <Field
          id="name"
          label="Name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          autoComplete="name"
          maxLength={80}
          required
        />
        <Field
          id="email"
          label="Email"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          autoComplete="username"
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
          message={signUp.isError ? messageFor(signUp.error, JOIN_ERRORS, JOIN_CODES) : null}
        />
        <Button type="submit" disabled={signUp.isPending}>
          Join workspace
        </Button>
      </form>
    </AuthCard>
  );
}
