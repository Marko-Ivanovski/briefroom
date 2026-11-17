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
