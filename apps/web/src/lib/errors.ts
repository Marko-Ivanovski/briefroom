import { ApiError } from '../api/client.ts';

const FALLBACK = 'Something went wrong. Try again.';

// byCode wins over byStatus, so a specific API code gets its own fixed string.
export function messageFor(
  err: unknown,
  byStatus: Record<number, string>,
  byCode: Record<string, string> = {},
): string {
  if (!(err instanceof ApiError)) return FALLBACK;
  return byCode[err.code] ?? byStatus[err.status] ?? FALLBACK;
}

export const PROJECT_ERRORS: Record<number, string> = {
  400: 'Check the project details and try again.',
  403: "You don't have permission to do that.",
  404: 'That project no longer exists.',
};

export const PROJECT_FORM_CODES: Record<string, string> = {
  remote_already_registered: 'This repo remote is already registered in this workspace.',
};

export const ADD_MEMBER_CODES: Record<string, string> = {
  already_on_project: 'Already on this project.',
  not_a_workspace_member: "That person isn't in this workspace.",
};
