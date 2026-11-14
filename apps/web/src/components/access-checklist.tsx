import type { ChecklistItem, ChecklistKind } from '@briefroom/contracts';
import { Button, Label } from '@briefroom/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client.ts';
import { checklistQuery, pendingRemovalsQuery } from '../api/queries.ts';
import { CHECKLIST_ERRORS, messageFor } from '../lib/errors.ts';
import { FormError } from './form-error.tsx';

interface AccessChecklistProps {
  workspaceId: string;
  projectId: string;
  userId: string;
  name: string;
  kind: ChecklistKind;
  onClose: () => void;
}

export function AccessChecklist({
  workspaceId,
  projectId,
  userId,
  name,
  kind,
  onClose,
}: AccessChecklistProps) {
  const queryClient = useQueryClient();
  const query = checklistQuery(workspaceId, projectId, userId, kind);
  const { data: items = [], error: loadError } = useQuery(query);

  const toggle = useMutation({
    mutationFn: (input: { toolLinkId: string; done: boolean }) =>
      api.setChecklistItem(workspaceId, projectId, userId, { ...input, kind }),
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: query.queryKey }),
        queryClient.invalidateQueries({
          queryKey: pendingRemovalsQuery(workspaceId, projectId).queryKey,
        }),
      ]),
  });

  const headingId = `checklist-${kind}-${userId}`;
  const error = loadError ?? toggle.error;

  return (
    <section aria-labelledby={headingId} className="mt-8 rounded-md border p-4">
      <div className="mb-3 flex items-center justify-between">
        <h2 id={headingId} className="font-semibold">
          Access to {kind} for {name}
        </h2>
        <Button variant="ghost" size="sm" onClick={onClose}>
          Close
        </Button>
      </div>
      <FormError message={error ? messageFor(error, CHECKLIST_ERRORS) : null} />
      {items.length === 0 && !error ? (
        <p className="text-muted-foreground text-sm">This project has no tool links.</p>
      ) : (
        <ul className="grid gap-3">
          {items.map((item) => (
            <ChecklistRow
              key={item.toolLinkId}
              item={item}
              disabled={toggle.isPending}
              onToggle={(done) => toggle.mutate({ toolLinkId: item.toolLinkId, done })}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

interface ChecklistRowProps {
  item: ChecklistItem;
  disabled: boolean;
  onToggle: (done: boolean) => void;
}

function ChecklistRow({ item, disabled, onToggle }: ChecklistRowProps) {
  const id = `checklist-item-${item.toolLinkId}`;
  return (
    <li className="flex flex-wrap items-center gap-3 text-sm">
      <input
        id={id}
        type="checkbox"
        className="size-4"
        checked={item.done}
        disabled={disabled}
        onChange={(e) => onToggle(e.target.checked)}
      />
      <Label htmlFor={id}>{item.label}</Label>
      <a
        href={item.url}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={`Open ${item.label}`}
        className="text-muted-foreground underline"
      >
        Open
      </a>
      {item.done && item.doneBy && item.doneAt ? (
        <span className="text-muted-foreground">
          Done by {item.doneBy}, {new Date(item.doneAt).toLocaleString()}
        </span>
      ) : null}
    </li>
  );
}
