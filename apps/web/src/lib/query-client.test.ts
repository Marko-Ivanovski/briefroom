import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api/client.ts';
import { createQueryClient } from './query-client.ts';

const MODULE_OFF = new ApiError(409, 'module_off', 'off');
const modulesKey = ['workspaces', 'w1', 'modules'];
const otherKey = ['workspaces', 'w1', 'members'];

function setup() {
  const onSessionEnd = vi.fn();
  const client: QueryClient = createQueryClient({ onSessionEnd });
  const invalidate = vi.spyOn(client, 'invalidateQueries');
  return { client, invalidate, onSessionEnd };
}

const wasInvalidated = (invalidate: ReturnType<typeof setup>['invalidate']) =>
  invalidate.mock.calls.some(([filters]) => {
    const predicate = (filters as { predicate?: (q: { queryKey: unknown[] }) => boolean })
      .predicate;
    return (
      predicate?.({ queryKey: modulesKey }) === true && predicate({ queryKey: otherKey }) === false
    );
  });

describe('createQueryClient', () => {
  it('refreshes the module list when a query answers module_off', async () => {
    const { client, invalidate } = setup();
    await client
      .fetchQuery({ queryKey: ['m', 1], queryFn: () => Promise.reject(MODULE_OFF) })
      .catch(() => {});
    expect(wasInvalidated(invalidate)).toBe(true);
  });

  it('refreshes the module list when a mutation answers module_off', async () => {
    const { client, invalidate } = setup();
    await client
      .getMutationCache()
      .build(client, { mutationFn: () => Promise.reject(MODULE_OFF) })
      .execute(undefined)
      .catch(() => {});
    expect(wasInvalidated(invalidate)).toBe(true);
  });

  it('leaves the module list alone for other errors', async () => {
    const { client, invalidate } = setup();
    const other = new ApiError(409, 'conflict', 'x');
    await client
      .fetchQuery({ queryKey: ['m', 2], queryFn: () => Promise.reject(other) })
      .catch(() => {});
    await client
      .getMutationCache()
      .build(client, { mutationFn: () => Promise.reject(new ApiError(500, 'x', 'x')) })
      .execute(undefined)
      .catch(() => {});
    expect(invalidate).not.toHaveBeenCalled();
  });

  it('ends the session on a 401 from a query', async () => {
    const { client, onSessionEnd } = setup();
    client.setQueryData(['keep'], 1);
    await client
      .fetchQuery({
        queryKey: ['m', 3],
        queryFn: () => Promise.reject(new ApiError(401, 'x', 'x')),
      })
      .catch(() => {});
    expect(onSessionEnd).toHaveBeenCalledOnce();
    expect(client.getQueryData(['keep'])).toBeUndefined();
  });
});
