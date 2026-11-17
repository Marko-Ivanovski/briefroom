import { Button } from '@briefroom/ui';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { createFileRoute, redirect, useNavigate } from '@tanstack/react-router';
import { useState, type FormEvent } from 'react';
import { api } from '../api/client.ts';
import { meQuery, setupStatusQuery } from '../api/queries.ts';
import { AuthCard } from '../components/auth-card.tsx';
import { Field } from '../components/field.tsx';
import { FormError } from '../components/form-error.tsx';
import { messageFor } from '../lib/errors.ts';

export const Route = createFileRoute('/sign-in')({
  validateSearch: (search: Record<string, unknown>): { next?: 'connect' } =>
    search.next === 'connect' ? { next: 'connect' } : {},
  beforeLoad: async ({ context: { queryClient }, search }) => {
    const { needsSetup } = await queryClient.query(setupStatusQuery);
    if (needsSetup) throw redirect({ to: '/setup' });
    if (await queryClient.query(meQuery))
      throw redirect({ to: search.next === 'connect' ? '/connect' : '/' });
  },
  component: SignInPage,
});

function SignInPage() {
  const navigate = useNavigate();
  const { next } = Route.useSearch();
  const queryClient = useQueryClient();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  const signIn = useMutation({
    mutationFn: () => api.signIn(email, password),
    onSuccess: async () => {
      queryClient.clear();
      await navigate({ to: next === 'connect' ? '/connect' : '/' });
    },
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    signIn.mutate();
  }

  return (
    <AuthCard title="Sign in to Briefroom">
      <form onSubmit={submit} className="grid gap-4">
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
          autoComplete="current-password"
          required
        />
        <FormError
          message={
            signIn.isError
              ? messageFor(signIn.error, {
                  401: 'Wrong email or password.',
                  429: 'Too many attempts. Wait a minute and try again.',
                })
              : null
          }
        />
        <Button type="submit" disabled={signIn.isPending}>
          Sign in
        </Button>
      </form>
    </AuthCard>
  );
}
