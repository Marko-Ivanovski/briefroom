import { ApiError } from '../api/client.ts';

const FALLBACK = 'Something went wrong. Try again.';

export function messageFor(err: unknown, byStatus: Record<number, string>): string {
  if (err instanceof ApiError) return byStatus[err.status] ?? FALLBACK;
  return FALLBACK;
}

export const PROJECT_ERRORS: Record<number, string> = {
  403: "You don't have permission to do that.",
  404: 'That project no longer exists.',
};
