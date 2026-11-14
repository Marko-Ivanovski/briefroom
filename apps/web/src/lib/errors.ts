import { ApiError } from '../api/client.ts';

const FALLBACK = 'Something went wrong. Try again.';

export function messageFor(err: unknown, byStatus: Record<number, string>): string {
  if (err instanceof ApiError) return byStatus[err.status] ?? FALLBACK;
  return FALLBACK;
}
