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

export const CHECKLIST_ERRORS: Record<number, string> = {
  ...PROJECT_ERRORS,
  404: 'That person or link is no longer on this project.',
  409: 'Someone else changed this at the same time. Reload and try again.',
};

export const JOIN_ERRORS: Record<number, string> = {
  400: 'Check your name, email and a password of at least 12 characters.',
  429: 'Too many attempts. Wait a minute and try again.',
};

export const JOIN_CODES: Record<string, string> = {
  invite_invalid: 'This invite link no longer works',
  already_member: 'You are already a member of this workspace.',
  already_requested: 'You already asked to join this workspace. Wait for an admin to approve it.',
  account_exists:
    'An account with this email already exists. Sign in, then open this invite link again.',
  join_failed: 'Joining failed. Try again.',
};

export const INVITE_ERRORS: Record<number, string> = {
  400: 'Check the invite settings and try again.',
  403: "You don't have permission to do that.",
  404: 'That invite link no longer exists.',
};

export const INVITE_CODES: Record<string, string> = {
  invalid_project: 'One of the chosen projects is no longer in this workspace.',
};

export const JOIN_REQUEST_ERRORS: Record<number, string> = {
  403: "You don't have permission to do that.",
  404: 'That request no longer exists.',
  409: 'That request was already handled.',
};

export const BOOKMARK_ERRORS: Record<number, string> = {
  400: 'Check the invite link and try again.',
  404: 'That bookmark no longer exists.',
  429: 'Too many attempts. Wait a minute and try again.',
  502: 'The other install did not answer. Check the link and try again.',
};

export const BOOKMARK_CODES: Record<string, string> = {
  invalid_invite_url: 'That is not a Briefroom invite link.',
  invite_invalid: 'This invite link no longer works.',
  host_unreachable: 'The other install did not answer. Check the link and try again.',
};

export const MEMBER_ERRORS: Record<number, string> = {
  403: "You don't have permission to remove that person.",
  404: 'That person is no longer in this workspace.',
  409: "The owner can't be removed or leave the workspace.",
};

export const MEMBER_CODES: Record<string, string> = {
  cannot_remove_owner: "The owner can't be removed from the workspace.",
  use_leave: 'Use Leave workspace to remove yourself.',
};
