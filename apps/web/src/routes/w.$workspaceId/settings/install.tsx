import type { InstallReach } from '@briefroom/contracts';
import { useQuery } from '@tanstack/react-query';
import { createFileRoute, Link, redirect } from '@tanstack/react-router';
import { installQuery, meQuery } from '../../../api/queries.ts';
import { CopyCommand } from '../../../components/copy-command.tsx';
import { FormError } from '../../../components/form-error.tsx';
import { INSTALL_ERRORS, messageFor } from '../../../lib/errors.ts';

export const Route = createFileRoute('/w/$workspaceId/settings/install')({
  loader: async ({ context: { queryClient }, params }) => {
    const me = await queryClient.query(meQuery);
    if (!me?.isInstallOwner) throw redirect({ to: '/w/$workspaceId', params });
    await queryClient.query({ ...installQuery, staleTime: 0 });
  },
  component: InstallPage,
});

const REACH_LABELS: Record<InstallReach, string> = {
  local: 'Only this computer',
  lan: 'Local network',
  tailscale: 'Tailscale',
  funnel: 'Tailscale Funnel',
  cloudflare: 'Cloudflare Tunnel',
};

function InstallPage() {
  const { workspaceId } = Route.useParams();
  const { data: info, error } = useQuery(installQuery);

  return (
    <section className="grid gap-6">
      <div>
        <h1 className="mb-1 text-2xl font-semibold">Install</h1>
        <p className="text-muted-foreground text-sm">
          How this Briefroom install is set up and who can reach it.
        </p>
      </div>
      <FormError message={error ? messageFor(error, INSTALL_ERRORS) : null} />
      {info ? (
        <>
          <dl className="grid gap-4 text-sm">
            <div>
              <dt className="text-muted-foreground">Address</dt>
              <dd>{info.publicUrl}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Reachable from</dt>
              <dd>{REACH_LABELS[info.reach]}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Install ID</dt>
              <dd className="font-mono">{info.installId}</dd>
            </div>
          </dl>
          <div className="grid gap-2">
            <h2 className="text-lg font-semibold">Change how people reach it</h2>
            <p className="text-muted-foreground text-sm">
              Run this on the machine that hosts Briefroom.
            </p>
            <CopyCommand command={info.changeCommand} label="Command to change access" />
          </div>
          <div className="grid gap-2">
            <h2 className="text-lg font-semibold">Reach it from anywhere</h2>
            <p className="text-muted-foreground text-sm">
              Switch on a Tailscale or Cloudflare tunnel from here, with no restart.
            </p>
            <p className="text-sm">
              <Link
                to="/w/$workspaceId/settings/remote-access"
                params={{ workspaceId }}
                className="underline"
              >
                Remote access settings
              </Link>
            </p>
          </div>
        </>
      ) : null}
    </section>
  );
}
