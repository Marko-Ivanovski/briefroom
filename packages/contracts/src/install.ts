import { z } from 'zod';
import { StartingModules } from './modules.ts';

export const SetupStatus = z.object({ needsSetup: z.boolean() });
export type SetupStatus = z.infer<typeof SetupStatus>;

export const SetupRequest = z.object({
  code: z.string().min(1).max(32),
  name: z.string().trim().min(1).max(100),
  email: z.email().max(254),
  password: z.string().min(12).max(128),
  modules: StartingModules,
});
export type SetupRequest = z.infer<typeof SetupRequest>;

export const SetupResponse = z.object({ userId: z.string(), workspaceId: z.string() });
export type SetupResponse = z.infer<typeof SetupResponse>;

export const InstallReach = z.enum(['local', 'lan', 'tailscale', 'funnel', 'cloudflare']);
export type InstallReach = z.infer<typeof InstallReach>;

export const InstallInfo = z.object({
  installId: z.string(),
  publicUrl: z.string(),
  reach: InstallReach,
  changeCommand: z.string(),
});
export type InstallInfo = z.infer<typeof InstallInfo>;

export const TunnelMode = z.enum(['tailscale', 'funnel', 'cloudflare']);
export type TunnelMode = z.infer<typeof TunnelMode>;

export const RemoteAccessMode = z.enum(['off', ...TunnelMode.options]);
export type RemoteAccessMode = z.infer<typeof RemoteAccessMode>;

export const RemoteAccessStatus = z.enum(['off', 'starting', 'running', 'restarting', 'error']);
export type RemoteAccessStatus = z.infer<typeof RemoteAccessStatus>;

export const RemoteAccessUpdate = z.object({
  mode: RemoteAccessMode,
  // Write-only. Left out, the stored secret is kept when the provider stays the same.
  secret: z.string().trim().min(1).max(4096).optional(),
  publicUrl: z.url().max(2048).optional(),
});
export type RemoteAccessUpdate = z.infer<typeof RemoteAccessUpdate>;

export const RemoteAccessSettings = z.object({
  mode: RemoteAccessMode,
  publicUrl: z.string().nullable(),
  status: RemoteAccessStatus,
  lastError: z.string().nullable(),
  hasSecret: z.boolean(),
});
export type RemoteAccessSettings = z.infer<typeof RemoteAccessSettings>;
