import { z } from 'zod';

export const Role = z.enum(['owner', 'admin', 'member']);
export type Role = z.infer<typeof Role>;

export const WorkspaceSummary = z.object({ id: z.string(), name: z.string(), role: Role });
export type WorkspaceSummary = z.infer<typeof WorkspaceSummary>;

export const CreateWorkspaceRequest = z.object({ name: z.string().trim().min(1).max(100) });
export type CreateWorkspaceRequest = z.infer<typeof CreateWorkspaceRequest>;
