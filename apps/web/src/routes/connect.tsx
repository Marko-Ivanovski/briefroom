import type { CliLoginPreviewed } from '@briefroom/contracts';
import { Button, Label } from '@briefroom/ui';
import { useMutation, useQuery } from '@tanstack/react-query';
import { createFileRoute, redirect } from '@tanstack/react-router';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { api, ApiError } from '../api/client.ts';
import { meQuery, workspacesQuery } from '../api/queries.ts';
import { AuthCard } from '../components/auth-card.tsx';
import { Field } from '../components/field.tsx';
import { FormError } from '../components/form-error.tsx';
import { normalizeCliLoginCode } from '../lib/cli-login-code.ts';
import { CONNECT_ERRORS, CONNECT_INVALID_CODE, messageFor } from '../lib/errors.ts';

// The code is typed by hand and never read from the URL, so a link cannot pre-fill an approval.
export const Route = createFileRoute('/connect')({
  validateSearch: (): Record<string, never> => ({}),
  beforeLoad: async ({ context: { queryClient } }) => {
    if (!(await queryClient.query(meQuery))) {
      throw redirect({ to: '/sign-in', search: { next: 'connect' } });
    }
    await queryClient.query(workspacesQuery);
  },
  component: ConnectPage,
});

const SELECT_CLASS =
  'border-input focus-visible:border-ring focus-visible:ring-ring/50 h-9 w-full rounded-md border bg-transparent px-3 text-sm shadow-xs outline-none focus-visible:ring-[3px]';

function ago(seconds: number): string {
  if (seconds < 60) return 'less than a minute ago';
  const minutes = Math.floor(seconds / 60);
  return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'} ago`;
}

interface Review {
  code: string;
  preview: CliLoginPreviewed;
}

function ConnectPage() {
  const { data: workspaces = [] } = useQuery(workspacesQuery);
  const [input, setInput] = useState('');
  const [review, setReview] = useState<Review | null>(null);
  const [workspaceId, setWorkspaceId] = useState('');
  const [invalid, setInvalid] = useState(false);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const previousStage = useRef<string | null>(null);

  const lookup = useMutation({
    mutationFn: (code: string) => api.cliLoginPreview(code),
    onSuccess: (preview, code) => {
      setWorkspaceId('');
      setReview({ code, preview });
    },
  });

  const approve = useMutation({
    mutationFn: ({ code, workspace }: { code: string; workspace: string }) =>
      api.cliLoginApprove(code, workspace),
    // A used or expired code cannot be approved, so the page goes back to asking for a code.
    onError: (error) => {
      if (error instanceof ApiError && error.status === 410) {
        setReview(null);
        setInput('');
        setInvalid(true);
        lookup.reset();
      }
    },
  });

  function restart() {
    setReview(null);
    setInput('');
    setInvalid(false);
    lookup.reset();
    approve.reset();
  }

  function submitCode(event: FormEvent) {
    event.preventDefault();
    const code = normalizeCliLoginCode(input);
    setInvalid(code === null);
    if (code !== null) lookup.mutate(code);
  }

  function submitApproval(event: FormEvent) {
    event.preventDefault();
    if (review && workspaceId) approve.mutate({ code: review.code, workspace: workspaceId });
  }

  const stage = approve.isSuccess ? 'done' : review ? 'review' : 'code';
  useEffect(() => {
    if (previousStage.current !== null && previousStage.current !== stage) {
      (stage === 'code' ? inputRef : headingRef).current?.focus();
    }
    previousStage.current = stage;
  }, [stage]);

  // The live region stays mounted and starts empty, so filling it is announced.
  const announcement = approve.isSuccess
    ? `Connected ${approve.data.deviceName} to ${approve.data.workspaceName}. You can return to your terminal.`
    : '';

  return (
    <>
      <div role="status" className="sr-only">
        {announcement}
      </div>
      {renderStage()}
    </>
  );

  function renderStage() {
    if (approve.isSuccess) {
      return (
        <AuthCard title="Connected" headingRef={headingRef}>
          <p className="text-sm">
            Connected {approve.data.deviceName} to {approve.data.workspaceName}. You can return to
            your terminal.
          </p>
        </AuthCard>
      );
    }

    if (!review) {
      return (
        <AuthCard title="Connect a terminal">
          <form onSubmit={submitCode} className="grid gap-4" noValidate>
            <Field
              id="connect-code"
              ref={inputRef}
              label="Code from your terminal"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              placeholder="XXXX-XXXX"
            />
            <FormError
              message={
                invalid
                  ? CONNECT_INVALID_CODE
                  : lookup.isError
                    ? messageFor(lookup.error, CONNECT_ERRORS)
                    : null
              }
            />
            <Button type="submit" disabled={lookup.isPending}>
              Continue
            </Button>
          </form>
        </AuthCard>
      );
    }

    const { preview } = review;
    return (
      <AuthCard title="Approve this login" headingRef={headingRef}>
        <form onSubmit={submitApproval} className="grid gap-4">
          <dl className="grid gap-1 text-sm">
            <div className="flex gap-2">
              <dt className="text-muted-foreground">Device</dt>
              <dd>{preview.deviceName}</dd>
            </div>
            <div className="flex gap-2">
              <dt className="text-muted-foreground">Started</dt>
              <dd>{ago(preview.startedSecondsAgo)}</dd>
            </div>
            <div className="flex gap-2">
              <dt className="text-muted-foreground">Network address</dt>
              <dd>{preview.startIp ?? 'Unknown'}</dd>
            </div>
            <div className="flex gap-2">
              <dt className="text-muted-foreground">Program</dt>
              <dd className="break-all">{preview.startUserAgent ?? 'Unknown'}</dd>
            </div>
          </dl>
          {preview.sameIpAsYou ? null : (
            <p
              role="alert"
              className="border-destructive text-destructive rounded-md border p-3 text-sm"
            >
              This login started from a different network than the one you are on now. If you did
              not start it from another place yourself, do not approve it.
            </p>
          )}
          <p role="note" className="rounded-md border p-3 text-sm">
            Only approve this if you just ran briefroom login yourself.
          </p>
          <div className="grid gap-2">
            <Label htmlFor="connect-workspace">Workspace</Label>
            <select
              id="connect-workspace"
              value={workspaceId}
              onChange={(e) => setWorkspaceId(e.target.value)}
              className={SELECT_CLASS}
            >
              <option value="">Choose a workspace</option>
              {workspaces.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </select>
          </div>
          <FormError message={approve.isError ? messageFor(approve.error, CONNECT_ERRORS) : null} />
          <div className="flex gap-2">
            <Button type="submit" disabled={!workspaceId || approve.isPending}>
              Approve
            </Button>
            <Button type="button" variant="ghost" onClick={restart}>
              Cancel
            </Button>
          </div>
        </form>
      </AuthCard>
    );
  }
}
