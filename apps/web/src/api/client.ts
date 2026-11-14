import {
  ChecklistItem,
  InviteCreated,
  InviteSummary,
  JoinLookup,
  JoinRequestSummary,
  JoinResult,
  MeResponse,
  MemberSummary,
  PendingRemoval,
  ProjectDetail,
  ProjectMemberSummary,
  ProjectSummary,
  SetupResponse,
  SetupStatus,
  WorkspaceSettings,
  WorkspaceSummary,
  type ChecklistKind,
  type InviteCreate,
  type JoinSignUp,
  type ProjectInput,
  type ProjectPatch,
  type SetChecklistItemInput,
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
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
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

const workspacePath = (workspaceId: string) =>
  `/api/v1/workspaces/${encodeURIComponent(workspaceId)}`;
const projectPath = (workspaceId: string, projectId: string) =>
  `${workspacePath(workspaceId)}/projects/${encodeURIComponent(projectId)}`;
const memberPath = (workspaceId: string, projectId: string, userId: string) =>
  `${projectPath(workspaceId, projectId)}/members/${encodeURIComponent(userId)}`;

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
  settings: (workspaceId: string) =>
    request(WorkspaceSettings, 'GET', `${workspacePath(workspaceId)}/settings`),
  projects: (workspaceId: string) =>
    request(ProjectSummary.array(), 'GET', `${workspacePath(workspaceId)}/projects`),
  project: (workspaceId: string, projectId: string) =>
    request(ProjectDetail, 'GET', projectPath(workspaceId, projectId)),
  createProject: (workspaceId: string, body: ProjectInput) =>
    request(ProjectDetail, 'POST', `${workspacePath(workspaceId)}/projects`, body),
  updateProject: (workspaceId: string, projectId: string, body: ProjectPatch) =>
    request(ProjectDetail, 'PATCH', projectPath(workspaceId, projectId), body),
  deleteProject: (workspaceId: string, projectId: string) =>
    request(null, 'DELETE', projectPath(workspaceId, projectId)),
  projectMembers: (workspaceId: string, projectId: string) =>
    request(ProjectMemberSummary.array(), 'GET', `${projectPath(workspaceId, projectId)}/members`),
  addProjectMember: (workspaceId: string, projectId: string, userId: string) =>
    request(ProjectMemberSummary, 'POST', `${projectPath(workspaceId, projectId)}/members`, {
      userId,
    }),
  removeProjectMember: (workspaceId: string, projectId: string, userId: string) =>
    request(null, 'DELETE', memberPath(workspaceId, projectId, userId)),
  leaveProject: (workspaceId: string, projectId: string) =>
    request(null, 'POST', `${projectPath(workspaceId, projectId)}/members/leave`),
  pendingRemovals: (workspaceId: string, projectId: string) =>
    request(
      PendingRemoval.array(),
      'GET',
      `${projectPath(workspaceId, projectId)}/pending-removals`,
    ),
  checklist: (workspaceId: string, projectId: string, userId: string, kind: ChecklistKind) =>
    request(
      ChecklistItem.array(),
      'GET',
      `${memberPath(workspaceId, projectId, userId)}/checklist?kind=${kind}`,
    ),
  setChecklistItem: (
    workspaceId: string,
    projectId: string,
    userId: string,
    body: SetChecklistItemInput,
  ) =>
    request(
      ChecklistItem,
      'PATCH',
      `${memberPath(workspaceId, projectId, userId)}/checklist`,
      body,
    ),
  invites: (workspaceId: string) =>
    request(InviteSummary.array(), 'GET', `${workspacePath(workspaceId)}/invites`),
  createInvite: (workspaceId: string, body: InviteCreate) =>
    request(InviteCreated, 'POST', `${workspacePath(workspaceId)}/invites`, body),
  revokeInvite: (workspaceId: string, inviteId: string) =>
    request(
      null,
      'DELETE',
      `${workspacePath(workspaceId)}/invites/${encodeURIComponent(inviteId)}`,
    ),
  joinRequests: (workspaceId: string) =>
    request(JoinRequestSummary.array(), 'GET', `${workspacePath(workspaceId)}/join-requests`),
  approveJoinRequest: (workspaceId: string, requestId: string) =>
    request(
      JoinResult,
      'POST',
      `${workspacePath(workspaceId)}/join-requests/${encodeURIComponent(requestId)}/approve`,
    ),
  declineJoinRequest: (workspaceId: string, requestId: string) =>
    request(
      null,
      'POST',
      `${workspacePath(workspaceId)}/join-requests/${encodeURIComponent(requestId)}/decline`,
    ),
  removeMember: (workspaceId: string, userId: string) =>
    request(null, 'DELETE', `${workspacePath(workspaceId)}/members/${encodeURIComponent(userId)}`),
  leaveWorkspace: (workspaceId: string) =>
    request(null, 'POST', `${workspacePath(workspaceId)}/leave`),
  joinLookup: (token: string) =>
    request(JoinLookup, 'GET', `/api/v1/join/${encodeURIComponent(token)}`),
  joinSignUp: (token: string, body: JoinSignUp) =>
    request(JoinResult, 'POST', `/api/v1/join/${encodeURIComponent(token)}/sign-up`, body),
  joinAccept: (token: string) =>
    request(JoinResult, 'POST', `/api/v1/join/${encodeURIComponent(token)}/accept`, {}),
  resetPassword: (token: string, password: string) =>
    request(null, 'POST', `/api/v1/reset/${encodeURIComponent(token)}`, { password }),
  signIn: (email: string, password: string) =>
    request(SignInResponse, 'POST', '/api/auth/sign-in/email', { email, password }),
  signOut: () => request(SignOutResponse, 'POST', '/api/auth/sign-out', {}),
};
