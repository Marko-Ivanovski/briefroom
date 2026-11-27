import type { RemoteAccessMode, RemoteAccessStatus } from '@briefroom/contracts';
import { Button, Input, Label } from '@briefroom/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createFileRoute, redirect } from '@tanstack/react-router';
import { useEffect, useState, type FormEvent } from 'react';
import { api, ApiError } from '../../../api/client.ts';
import { installQuery, meQuery, remoteAccessQuery } from '../../../api/queries.ts';
import { FormError } from '../../../components/form-error.tsx';
import { REMOTE_ACCESS_ERRORS, messageFor } from '../../../lib/errors.ts';

export const Route = createFileRoute('/w/$workspaceId/settings/remote-access')({
  loader: async ({ context: { queryClient }, params }) => {
    const me = await queryClient.query(meQuery);
    if (!me?.isInstallOwner) throw redirect({ to: '/w/$workspaceId', params });
    await queryClient.query({ ...remoteAccessQuery, staleTime: 0 });
  },
  component: RemoteAccessPage,
});

const SELECT_CLASS =
  'border-input focus-visible:border-ring focus-visible:ring-ring/50 h-9 min-w-40 rounded-md border bg-transparent px-3 text-sm shadow-xs outline-none focus-visible:ring-[3px]';

interface ModeCopy {
  label: string;
  secretLabel: string;
  urlHint: string;
  steps: string;
}

const MODES: Record<Exclude<RemoteAccessMode, 'off'>, ModeCopy> = {
  tailscale: {
    label: 'Tailscale (people on your tailnet)',
    secretLabel: 'Tailscale auth key',
    urlHint: 'https://briefroom.<your-tailnet>.ts.net',
    steps:
      'Create an auth key in the Tailscale admin console and turn on MagicDNS and HTTPS certificates for the tailnet. This install joins as the machine "briefroom".',
  },
  funnel: {
    label: 'Tailscale Funnel (anyone with the link)',
    secretLabel: 'Tailscale auth key',
    urlHint: 'https://briefroom.<your-tailnet>.ts.net',
    steps:
      'Same as Tailscale, and the tailnet policy must allow Funnel for this machine. Funnel serves on port 443.',
  },
  cloudflare: {
    label: 'Cloudflare Tunnel (anyone with the link)',
    secretLabel: 'Cloudflare tunnel token',
    urlHint: 'https://briefroom.example.com',
    steps:
      'In the Cloudflare dashboard, create a tunnel and add a public hostname with service type UNIX and path /run/briefroom/tunnel.sock, then copy the tunnel token. Pointed at the TCP port instead, every visitor shares one rate limit and cookies lose Secure.',
  },
};

const STATUS_LABELS: Record<RemoteAccessStatus, string> = {
  off: 'Off',
  starting: 'Starting',
  running: 'Running',
  restarting: 'Restarting after a failure',
  error: 'Stopped by an error',
};

const provider = (mode: RemoteAccessMode) => (mode === 'cloudflare' ? 'cloudflare' : 'tailscale');

function errorMessage(err: unknown): string {
  // A 400 names the field to fix, and never carries the secret.
  if (err instanceof ApiError && err.status === 400) return err.message;
  return messageFor(err, REMOTE_ACCESS_ERRORS);
}

function RemoteAccessPage() {
  const queryClient = useQueryClient();
  const { data: settings, error } = useQuery({
    ...remoteAccessQuery,
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status === 'starting' || status === 'restarting' ? 3000 : false;
    },
  });
  const [mode, setMode] = useState<RemoteAccessMode>('off');
  const [publicUrl, setPublicUrl] = useState('');
  // Write-only: never filled from the server, and cleared after every save.
  const [secret, setSecret] = useState('');

  // Follows the saved settings only when they change, so a poll never overwrites what is typed.
  const savedMode = settings?.mode;
  const savedUrl = settings?.publicUrl;
  useEffect(() => {
    if (savedMode === undefined) return;
    setMode(savedMode);
    setPublicUrl(savedUrl ?? '');
  }, [savedMode, savedUrl]);

  const save = useMutation({
    mutationFn: () =>
      api.updateRemoteAccess(
        mode === 'off'
          ? { mode }
          : { mode, publicUrl: publicUrl.trim(), ...(secret.trim() ? { secret } : {}) },
      ),
    onSuccess: async (next) => {
      setSecret('');
      queryClient.setQueryData(remoteAccessQuery.queryKey, next);
      await queryClient.invalidateQueries({ queryKey: installQuery.queryKey });
    },
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    save.mutate();
  }

  const copy = mode === 'off' ? null : MODES[mode];
  const keepsSecret =
    !!settings?.hasSecret && settings.mode !== 'off' && provider(settings.mode) === provider(mode);

  return (
    <section className="grid gap-6">
      <div>
        <h1 className="mb-1 text-2xl font-semibold">Remote access</h1>
        <p className="text-muted-foreground text-sm">
          Let people outside this network open Briefroom, through Tailscale or Cloudflare. Switching
          it on or off takes effect without a restart.
        </p>
      </div>
      <FormError message={error ? messageFor(error, REMOTE_ACCESS_ERRORS) : null} />
      {settings ? (
        <dl className="grid gap-4 text-sm">
          <div>
            <dt className="text-muted-foreground">Status</dt>
            <dd role="status">{STATUS_LABELS[settings.status]}</dd>
          </div>
          {settings.mode !== 'off' && settings.publicUrl ? (
            <div>
              <dt className="text-muted-foreground">Public address</dt>
              <dd>{settings.publicUrl}</dd>
            </div>
          ) : null}
          {settings.lastError ? (
            <div>
              <dt className="text-muted-foreground">Last error</dt>
              <dd className="font-mono text-xs break-words">{settings.lastError}</dd>
            </div>
          ) : null}
        </dl>
      ) : null}
      <form onSubmit={submit} className="grid max-w-xl gap-4">
        <div className="grid gap-2">
          <Label htmlFor="remote-mode">How people connect</Label>
          <select
            id="remote-mode"
            value={mode}
            onChange={(e) => setMode(e.target.value as RemoteAccessMode)}
            className={SELECT_CLASS}
          >
            <option value="off">Off</option>
            {Object.entries(MODES).map(([value, m]) => (
              <option key={value} value={value}>
                {m.label}
              </option>
            ))}
          </select>
        </div>
        {copy ? (
          <>
            <p className="text-muted-foreground text-sm">{copy.steps}</p>
            <div className="grid gap-2">
              <Label htmlFor="remote-url">Public address</Label>
              <Input
                id="remote-url"
                type="url"
                inputMode="url"
                placeholder={copy.urlHint}
                value={publicUrl}
                onChange={(e) => setPublicUrl(e.target.value)}
                required
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="remote-secret">{copy.secretLabel}</Label>
              <Input
                id="remote-secret"
                type="password"
                autoComplete="off"
                spellCheck={false}
                value={secret}
                onChange={(e) => setSecret(e.target.value)}
                required={!keepsSecret}
                aria-describedby="remote-secret-hint"
              />
              <p id="remote-secret-hint" className="text-muted-foreground text-xs">
                {keepsSecret
                  ? 'One is stored. Leave this empty to keep it.'
                  : 'None is stored for this provider yet.'}{' '}
                It is stored encrypted and never shown again.
              </p>
            </div>
          </>
        ) : (
          <p className="text-muted-foreground text-sm">
            Switching off stops the tunnel and deletes the stored secret.
          </p>
        )}
        <FormError message={save.isError ? errorMessage(save.error) : null} />
        <div>
          <Button type="submit" disabled={save.isPending}>
            {mode === 'off' ? 'Save' : 'Save and connect'}
          </Button>
        </div>
      </form>
    </section>
  );
}
