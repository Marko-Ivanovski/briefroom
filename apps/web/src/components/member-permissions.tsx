import { Label } from '@briefroom/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../api/client.ts';
import { memberPermissionsQuery } from '../api/queries.ts';
import { PERMISSION_CODES, PERMISSION_ERRORS, messageFor } from '../lib/errors.ts';
import { FormError } from './form-error.tsx';

interface MemberPermissionsProps {
  workspaceId: string;
  userId: string;
  name: string;
}

export function MemberPermissions({ workspaceId, userId, name }: MemberPermissionsProps) {
  const queryClient = useQueryClient();
  const query = memberPermissionsQuery(workspaceId, userId);
  const { data: permissions = [] } = useQuery(query);
  const [pending, setPending] = useState<Record<string, boolean>>({});

  const set = useMutation({
    mutationFn: (v: { moduleId: string; key: string; granted: boolean }) =>
      api.setMemberPermission(workspaceId, userId, v),
    onSettled: async () => {
      await queryClient.invalidateQueries(query);
      setPending({});
    },
  });

  if (permissions.length === 0) return null;
  return (
    <div className="grid gap-1">
      {permissions.map((p) => {
        const id = `perm-${userId}-${p.moduleId}-${p.key}`;
        return (
          <div key={id} className="flex items-center gap-2">
            <input
              id={id}
              type="checkbox"
              className="size-4"
              aria-label={`${p.label} for ${name}`}
              checked={p.implied || (pending[id] ?? p.granted)}
              disabled={p.implied}
              onChange={(e) => {
                setPending((current) => ({ ...current, [id]: e.target.checked }));
                set.mutate({ moduleId: p.moduleId, key: p.key, granted: e.target.checked });
              }}
            />
            <Label htmlFor={id}>{p.label}</Label>
            <span className="text-muted-foreground text-xs">{p.description}</span>
            {p.implied ? (
              <span className="text-muted-foreground text-xs">implied by role</span>
            ) : null}
          </div>
        );
      })}
      <FormError
        message={set.isError ? messageFor(set.error, PERMISSION_ERRORS, PERMISSION_CODES) : null}
      />
    </div>
  );
}
