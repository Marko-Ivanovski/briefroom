import { Button } from '@briefroom/ui';
import { useMutation } from '@tanstack/react-query';
import { createFileRoute, Link } from '@tanstack/react-router';
import { useState, type FormEvent } from 'react';
import { api } from '../api/client.ts';
import { AuthCard } from '../components/auth-card.tsx';
import { Field } from '../components/field.tsx';
import { FormError } from '../components/form-error.tsx';
import { messageFor } from '../lib/errors.ts';

export const Route = createFileRoute('/reset/$token')({
  component: ResetPage,
});

function ResetPage() {
  const { token } = Route.useParams();
  const [password, setPassword] = useState('');
  const reset = useMutation({ mutationFn: () => api.resetPassword(token, password) });

  function submit(event: FormEvent) {
    event.preventDefault();
    reset.mutate();
  }

  if (reset.isSuccess) {
    return (
      <AuthCard title="Password changed">
        <p role="status" className="mb-4 text-sm">
          Your password is set. You can sign in with it now.
        </p>
        <Button asChild>
          <Link to="/sign-in">Sign in</Link>
        </Button>
      </AuthCard>
    );
  }

  return (
    <AuthCard title="Choose a new password">
      <form onSubmit={submit} className="grid gap-4">
        <Field
          id="password"
          label="New password"
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
            reset.isError
              ? messageFor(reset.error, {
                  400: 'The password needs at least 12 characters.',
                  410: 'This reset link no longer works.',
                })
              : null
          }
        />
        <Button type="submit" disabled={reset.isPending}>
          Set password
        </Button>
      </form>
    </AuthCard>
  );
}
