import { Button } from '@briefroom/ui';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { api } from '../api/client.ts';
import { bookmarksQuery } from '../api/queries.ts';
import { BOOKMARK_CODES, BOOKMARK_ERRORS, messageFor } from '../lib/errors.ts';
import { safeHttpUrl } from '../lib/safe-url.ts';
import { Field } from './field.tsx';
import { FormError } from './form-error.tsx';

interface JoinWorkspaceDialogProps {
  open: boolean;
  onClose: () => void;
}

export function JoinWorkspaceDialog({ open, onClose }: JoinWorkspaceDialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const queryClient = useQueryClient();
  const [inviteUrl, setInviteUrl] = useState('');

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  const add = useMutation({
    mutationFn: () => api.createBookmark(inviteUrl.trim()),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: bookmarksQuery.queryKey }),
  });
  // A popup opened after an async call is blocked by browsers, so the link is shown instead.
  const continueUrl = add.data ? safeHttpUrl(add.data.joinUrl) : null;

  function close() {
    add.reset();
    setInviteUrl('');
    onClose();
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    add.mutate();
  }

  return (
    <dialog
      ref={ref}
      onClose={close}
      aria-labelledby="join-workspace-title"
      className="bg-background text-foreground m-auto w-full max-w-md rounded-lg border p-6 backdrop:bg-black/40"
    >
      <form onSubmit={submit} className="grid gap-4">
        <h2 id="join-workspace-title" className="text-lg font-semibold">
          Join a workspace
        </h2>
        <p className="text-muted-foreground text-sm">
          Paste an invite link from another Briefroom install. It is saved as a bookmark here and
          opens in a new tab so you can join.
        </p>
        <Field
          id="invite-url"
          label="Invite link"
          type="url"
          required
          value={inviteUrl}
          onChange={(e) => setInviteUrl(e.target.value)}
        />
        <FormError
          message={add.isError ? messageFor(add.error, BOOKMARK_ERRORS, BOOKMARK_CODES) : null}
        />
        {continueUrl ? (
          <p role="status" className="text-sm">
            Saved as a bookmark.{' '}
            <a
              href={continueUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="font-medium underline"
            >
              Continue to join
            </a>
          </p>
        ) : null}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={close}>
            {continueUrl ? 'Close' : 'Cancel'}
          </Button>
          <Button type="submit" disabled={add.isPending}>
            Join
          </Button>
        </div>
      </form>
    </dialog>
  );
}
