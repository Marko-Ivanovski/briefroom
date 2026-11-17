import {
  Button,
  Input,
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
import { useEffect, useState, type FormEvent } from 'react';
import { api } from '../../../api/client.ts';
import { tokensQuery } from '../../../api/queries.ts';
import { FormError } from '../../../components/form-error.tsx';
import { TOKEN_ERRORS, messageFor } from '../../../lib/errors.ts';

export const Route = createFileRoute('/w/$workspaceId/settings/tokens')({
  loader: async ({ context: { queryClient }, params }) => {
    await queryClient.query({ ...tokensQuery(params.workspaceId), staleTime: 0 });
  },
  component: TokensPage,
});

interface NewToken {
  name: string;
  token: string;
}

function TokensPage() {
  const { workspaceId } = Route.useParams();
  const queryClient = useQueryClient();
  const { data: tokens = [] } = useQuery(tokensQuery(workspaceId));
  const [name, setName] = useState('');
  // The plaintext lives only here. It is not a mutation result, so no query cache keeps it.
  const [created, setCreated] = useState<NewToken | null>(null);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<unknown>(null);
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const [confirming, setConfirming] = useState<string | null>(null);

  useEffect(() => {
    setCreated(null);
    setConfirming(null);
  }, [workspaceId]);

  const revoke = useMutation({
    mutationFn: (id: string) => api.deleteToken(workspaceId, id),
    onSuccess: async () => {
      setConfirming(null);
      await queryClient.invalidateQueries({ queryKey: tokensQuery(workspaceId).queryKey });
    },
  });

  async function submit(event: FormEvent) {
    event.preventDefault();
    setCreating(true);
    setCreateError(null);
    try {
      const result = await api.createToken(workspaceId, name);
      setCreated({ name: result.name, token: result.token });
      setCopied(false);
      setCopyFailed(false);
      setName('');
      await queryClient.invalidateQueries({ queryKey: tokensQuery(workspaceId).queryKey });
    } catch (err) {
      setCreateError(err);
    } finally {
      setCreating(false);
    }
  }

  async function copy(token: string) {
    setCopyFailed(false);
    try {
      await navigator.clipboard.writeText(token);
      setCopied(true);
    } catch {
      setCopyFailed(true);
    }
  }

  return (
    <section className="grid gap-8">
      <div>
        <h1 className="mb-1 text-2xl font-semibold">Access tokens</h1>
        <p className="text-muted-foreground mb-4 text-sm">
          Tokens let an agent or the CLI read this workspace as you. You only see your own.
        </p>
        <form onSubmit={submit} className="flex flex-wrap items-end gap-4">
          <div className="grid gap-2">
            <Label htmlFor="token-name">Token name</Label>
            <Input
              id="token-name"
              value={name}
              maxLength={80}
              required
              onChange={(e) => setName(e.target.value)}
              className="w-64"
            />
          </div>
          <Button type="submit" disabled={creating}>
            Create token
          </Button>
        </form>
        <FormError message={createError ? messageFor(createError, TOKEN_ERRORS) : null} />
      </div>

      {created ? (
        <section aria-label="New token" className="grid gap-3 rounded-md border p-4">
          <p className="text-sm">Copy the token for {created.name} now. It won't be shown again.</p>
          <div className="flex gap-2">
            <Input aria-label="Token" readOnly value={created.token} />
            <Button type="button" variant="outline" onClick={() => copy(created.token)}>
              Copy token
            </Button>
            <Button type="button" variant="ghost" onClick={() => setCreated(null)}>
              Dismiss
            </Button>
          </div>
          {copied ? (
            <p role="status" className="text-sm">
              Copied
            </p>
          ) : null}
          <FormError
            message={copyFailed ? "Couldn't copy. Select the token and copy it by hand." : null}
          />
        </section>
      ) : null}

      <div>
        <h2 className="mb-3 text-lg font-semibold">Your tokens</h2>
        <FormError message={revoke.isError ? messageFor(revoke.error, TOKEN_ERRORS) : null} />
        {tokens.length === 0 ? (
          <p className="text-muted-foreground text-sm">You have no tokens in this workspace.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Created</TableHead>
                <TableHead>Last used</TableHead>
                <TableHead>Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {tokens.map((t) => (
                <TableRow key={t.id}>
                  <TableCell>{t.name}</TableCell>
                  <TableCell>{new Date(t.createdAt).toLocaleDateString()}</TableCell>
                  <TableCell>
                    {t.lastUsedAt ? new Date(t.lastUsedAt).toLocaleDateString() : 'Never'}
                  </TableCell>
                  <TableCell>
                    {confirming === t.id ? (
                      <div
                        role="group"
                        aria-label={`Confirm revoking ${t.name}`}
                        className="flex gap-2"
                      >
                        <Button
                          variant="destructive"
                          size="sm"
                          aria-label={`Confirm revoke ${t.name}`}
                          disabled={revoke.isPending}
                          onClick={() => revoke.mutate(t.id)}
                        >
                          Confirm revoke
                        </Button>
                        <Button variant="ghost" size="sm" onClick={() => setConfirming(null)}>
                          Cancel
                        </Button>
                      </div>
                    ) : (
                      <Button
                        variant="outline"
                        size="sm"
                        aria-label={`Revoke ${t.name}`}
                        onClick={() => setConfirming(t.id)}
                      >
                        Revoke
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>
    </section>
  );
}
