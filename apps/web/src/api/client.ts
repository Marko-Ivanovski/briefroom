import {
  MeResponse,
  MemberSummary,
  SetupResponse,
  SetupStatus,
  WorkspaceSummary,
  type SetupRequest,
} from '@briefroom/contracts';
import { z } from 'zod';

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

interface ErrorBody {
  code?: unknown;
  error?: unknown;
  message?: unknown;
}

async function toApiError(res: Response): Promise<ApiError> {
  let body: ErrorBody = {};
  try {
    body = (await res.json()) as ErrorBody;
  } catch {
    // Non-JSON error bodies fall back to the status text.
  }
  const code =
    typeof body.code === 'string'
      ? body.code
      : typeof body.error === 'string'
        ? body.error
        : String(res.status);
  const message = typeof body.message === 'string' ? body.message : res.statusText;
  return new ApiError(res.status, code, message);
}

async function request<T>(
  schema: z.ZodType<T> | null,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw await toApiError(res);
  if (schema === null) return undefined as T;
  return schema.parse(await res.json());
}

// Better Auth answers these three with its own shapes. Only what the web app reads is declared.
const SignInResponse = z.object({ user: z.object({ id: z.string() }) });
const SignOutResponse = z.object({ success: z.boolean() });

export const api = {
  setupStatus: () => request(SetupStatus, 'GET', '/api/v1/setup'),
  setup: (body: SetupRequest) => request(SetupResponse, 'POST', '/api/v1/setup', body),
  me: () => request(MeResponse, 'GET', '/api/v1/me'),
  workspaces: () => request(WorkspaceSummary.array(), 'GET', '/api/v1/workspaces'),
  createWorkspace: (name: string) =>
    request(WorkspaceSummary, 'POST', '/api/v1/workspaces', { name }),
  members: (workspaceId: string) =>
    request(
      MemberSummary.array(),
      'GET',
      `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/members`,
    ),
  resetPassword: (token: string, password: string) =>
    request(null, 'POST', `/api/v1/reset/${encodeURIComponent(token)}`, { password }),
  signIn: (email: string, password: string) =>
    request(SignInResponse, 'POST', '/api/auth/sign-in/email', { email, password }),
  signOut: () => request(SignOutResponse, 'POST', '/api/auth/sign-out', {}),
};
