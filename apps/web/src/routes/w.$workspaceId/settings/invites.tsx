import type { InviteRole, InviteSummary } from '@briefroom/contracts';
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
import { createFileRoute, redirect } from '@tanstack/react-router';
import { useState, type FormEvent } from 'react';
import { api } from '../../../api/client.ts';
import { invitesQuery, projectsQuery, workspacesQuery } from '../../../api/queries.ts';
import { FormError } from '../../../components/form-error.tsx';
import { CopyCommand } from '../../../components/copy-command.tsx';
import { QrCode } from '../../../components/qr-code.tsx';
import { INVITE_CODES, INVITE_ERRORS, messageFor } from '../../../lib/errors.ts';
import { isAdminRole } from '../../../lib/roles.ts';

export const Route = createFileRoute('/w/$workspaceId/settings/invites')({
  loader: async ({ context: { queryClient }, params }) => {
    const workspaces = await queryClient.query({ ...workspacesQuery, staleTime: 'static' });
    if (!isAdminRole(workspaces.find((w) => w.id === params.workspaceId)?.role)) {
      throw redirect({ to: '/w/$workspaceId', params });
    }
    await Promise.all([
      queryClient.query({ ...invitesQuery(params.workspaceId), staleTime: 0 }),
      queryClient.query({ ...projectsQuery(params.workspaceId), staleTime: 'static' }),
    ]);
  },
  component: InvitesPage,
});

const ROLE_LABELS: Record<InviteRole, string> = { member: 'Member', admin: 'Admin' };
const SELECT_CLASS =
  'border-input focus-visible:border-ring focus-visible:ring-ring/50 h-9 min-w-40 rounded-md border bg-transparent px-3 text-sm shadow-xs outline-none focus-visible:ring-[3px]';

function inviteStatus(invite: InviteSummary): string {
  const expires = new Date(invite.expiresAt).toLocaleDateString();
  return `Active, expires ${expires}`;
}

function InvitesPage() {
  const { workspaceId } = Route.useParams();
  const queryClient = useQueryClient();
  const { data: invites = [] } = useQuery(invitesQuery(workspaceId));
  const { data: projects = [] } = useQuery(projectsQuery(workspaceId));
  const [role, setRole] = useState<InviteRole>('member');
  const [maxUses, setMaxUses] = useState('');
  const [approval, setApproval] = useState(false);
  const [projectIds, setProjectIds] = useState<string[]>([]);
  const [created, setCreated] = useState<{ id: string; url: string; unreachable: boolean } | null>(
    null,
  );
  const [links, setLinks] = useState<Record<string, string>>({});
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [copyFailed, setCopyFailed] = useState(false);

  // An admin link always needs approval, and the API enforces the same rule.
  const requiresApproval = role === 'admin' || approval;

  const create = useMutation({
    mutationFn: () =>
      api.createInvite(workspaceId, {
        role,
        expiresInDays: 7,
        maxUses: maxUses === '' ? null : Number(maxUses),
        requiresApproval,
        projectIds,
      }),
    onSuccess: async (invite) => {
      const url = invite.url;
      setCreated({ id: invite.id, url, unreachable: invite.warning === 'install_not_reachable' });
      setLinks((prev) => ({ ...prev, [invite.id]: url }));
      setCopiedId(null);
      await queryClient.invalidateQueries({ queryKey: invitesQuery(workspaceId).queryKey });
    },
  });

  const revoke = useMutation({
    mutationFn: (id: string) => api.revokeInvite(workspaceId, id),
    onSuccess: async (_, id) => {
      if (created?.id === id) setCreated(null);
      await queryClient.invalidateQueries({ queryKey: invitesQuery(workspaceId).queryKey });
    },
  });

  async function copy(id: string, url: string) {
    setCopyFailed(false);
    try {
      await navigator.clipboard.writeText(url);
      setCopiedId(id);
    } catch {
      setCopyFailed(true);
    }
  }

  function toggleProject(id: string, checked: boolean) {
    setProjectIds((prev) => (checked ? [...prev, id] : prev.filter((p) => p !== id)));
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    create.mutate();
  }

  return (
    <section className="grid gap-8">
      <div>
        <h1 className="mb-4 text-2xl font-semibold">Invite links</h1>
        <form onSubmit={submit} className="grid gap-4">
          <div className="flex flex-wrap items-end gap-4">
            <div className="grid gap-2">
              <Label htmlFor="invite-role">Role</Label>
              <select
                id="invite-role"
                value={role}
                onChange={(e) => setRole(e.target.value as InviteRole)}
                className={SELECT_CLASS}
              >
                <option value="member">{ROLE_LABELS.member}</option>
                <option value="admin">{ROLE_LABELS.admin}</option>
              </select>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="invite-max-uses">Max uses</Label>
              <Input
                id="invite-max-uses"
                type="number"
                min={1}
                placeholder="Unlimited"
                value={maxUses}
                onChange={(e) => setMaxUses(e.target.value)}
                className="w-32"
              />
            </div>
            <div className="flex items-center gap-2 pb-2">
              <input
                id="invite-approval"
                type="checkbox"
                className="size-4"
                checked={requiresApproval}
                disabled={role === 'admin'}
                onChange={(e) => setApproval(e.target.checked)}
              />
              <Label htmlFor="invite-approval">Requires approval</Label>
            </div>
          </div>
          {role === 'admin' ? (
            <p className="text-muted-foreground text-xs">
              Links that grant the admin role always need approval.
            </p>
          ) : null}
          {projects.length > 0 ? (
            <fieldset className="grid gap-2">
              <legend className="mb-1 text-sm font-medium">Projects to add people to</legend>
              {projects.map((p) => (
                <div key={p.id} className="flex items-center gap-2">
                  <input
                    id={`invite-project-${p.id}`}
                    type="checkbox"
                    className="size-4"
                    checked={projectIds.includes(p.id)}
                    onChange={(e) => toggleProject(p.id, e.target.checked)}
                  />
                  <Label htmlFor={`invite-project-${p.id}`}>{p.name}</Label>
                </div>
              ))}
            </fieldset>
          ) : null}
          <FormError
            message={create.isError ? messageFor(create.error, INVITE_ERRORS, INVITE_CODES) : null}
          />
          <div>
            <Button type="submit" disabled={create.isPending}>
              Create invite link
            </Button>
          </div>
        </form>
      </div>

      {created ? (
        <section aria-label="New invite link" className="grid gap-3 rounded-md border p-4">
          <p className="text-sm">Copy this link now. It is not shown again.</p>
          <div className="flex gap-2">
            <Input aria-label="Invite link" readOnly value={created.url} />
            <Button type="button" variant="outline" onClick={() => copy(created.id, created.url)}>
              Copy link
            </Button>
          </div>
          {copiedId === created.id ? (
            <p role="status" className="text-sm">
              Copied
            </p>
          ) : null}
          <QrCode value={created.url} label="QR code for the invite link" />
          {created.unreachable ? (
            <div role="note" className="grid gap-2 border-t pt-3">
              <p className="text-sm font-medium">Only this computer can open this link yet.</p>
              <p className="text-muted-foreground text-sm">
                To let other people reach this install, run this command on the machine that hosts
                it and pick how they will connect.
              </p>
              <CopyCommand command="npx briefroom init" label="Command to open the install" />
            </div>
          ) : null}
        </section>
      ) : null}

      <div>
        <h2 className="mb-3 text-lg font-semibold">Active links</h2>
        <FormError
          message={
            revoke.isError
              ? messageFor(revoke.error, INVITE_ERRORS)
              : copyFailed
                ? "Couldn't copy. Select the link and copy it by hand."
                : null
          }
        />
        {invites.length === 0 ? (
          <p className="text-muted-foreground text-sm">No active invite links.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Role</TableHead>
                <TableHead>Uses</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {invites.map((invite) => (
                <TableRow key={invite.id}>
                  <TableCell>
                    {ROLE_LABELS[invite.role]}
                    {invite.requiresApproval ? ', needs approval' : ''}
                  </TableCell>
                  <TableCell>
                    {invite.uses} of {invite.maxUses ?? 'unlimited'}
                  </TableCell>
                  <TableCell>{inviteStatus(invite)}</TableCell>
                  <TableCell>
                    <div className="flex gap-2">
                      {links[invite.id] ? (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => copy(invite.id, links[invite.id] ?? '')}
                        >
                          Copy
                        </Button>
                      ) : null}
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={revoke.isPending}
                        onClick={() => revoke.mutate(invite.id)}
                      >
                        Revoke
                      </Button>
                    </div>
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
