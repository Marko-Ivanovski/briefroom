import { z } from 'zod';

export const CLI_LOGIN_CODE = /^[A-HJ-KM-NP-Z2-9]{4}-[A-HJ-KM-NP-Z2-9]{4}$/;
export const CLI_LOGIN_TTL_MS = 10 * 60 * 1000;
export const CLI_LOGIN_POLL_INTERVAL_SECONDS = 2;

export const CliLoginStart = z.object({ deviceName: z.string().max(500).optional() });
export type CliLoginStart = z.infer<typeof CliLoginStart>;

export interface CliLoginStarted {
  code: string;
  approveUrl: string;
  pollToken: string;
  expiresAt: string;
  interval: number;
}

export const CliLoginApprove = z.object({
  code: z.string().regex(CLI_LOGIN_CODE),
  workspaceId: z.string().min(1),
});
export type CliLoginApprove = z.infer<typeof CliLoginApprove>;

export interface CliLoginApproved {
  deviceName: string;
  startedAt: string;
  workspaceName: string;
}

export const CliLoginPoll = z.object({ pollToken: z.string().min(1).max(256) });
export type CliLoginPoll = z.infer<typeof CliLoginPoll>;

export type CliLoginPollResult =
  | { status: 'pending' }
  | { status: 'expired' }
  | {
      status: 'approved';
      token: string;
      workspaceId: string;
      workspaceName: string;
      installId: string;
      baseUrl: string;
    };
