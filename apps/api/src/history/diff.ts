import type { Changes } from '@briefroom/db';

const LEFT_OUT = new Set([
  'id',
  'workspaceId',
  'workspace_id',
  'createdBy',
  'createdAt',
  'createdVia',
  'createdAgent',
  'updatedBy',
  'updatedAt',
  'updatedVia',
  'updatedAgent',
  'created_by',
  'created_at',
  'created_via',
  'created_agent',
  'updated_by',
  'updated_at',
  'updated_via',
  'updated_agent',
]);

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/** The fields that really changed. A null `before` is a creation, so every set field shows `from: null`. */
export function diffRecord(
  before: Record<string, unknown> | null,
  after: Record<string, unknown>,
): Changes {
  const changes: Changes = {};
  const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after)]);
  for (const key of keys) {
    if (LEFT_OUT.has(key)) continue;
    const from = before?.[key] ?? null;
    const to = after[key] ?? null;
    if (!sameValue(from, to)) changes[key] = { from, to };
  }
  return changes;
}
