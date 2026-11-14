import { z } from 'zod';

export const ModuleId = z.string().min(1).max(64);

export const ModuleSummary = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  enabled: z.boolean(),
});
export type ModuleSummary = z.infer<typeof ModuleSummary>;

export const AvailableModule = ModuleSummary.omit({ enabled: true });
export type AvailableModule = z.infer<typeof AvailableModule>;

export const UpdateModuleRequest = z
  .object({
    enabled: z.boolean().optional(),
    settings: z.record(z.string(), z.unknown()).optional(),
  })
  .refine((v) => v.enabled !== undefined || v.settings !== undefined, {
    message: 'enabled or settings is required',
  });
export type UpdateModuleRequest = z.infer<typeof UpdateModuleRequest>;

/** `implied` marks a permission held through the owner or admin role, not through a grant. */
export const MemberPermission = z.object({
  moduleId: z.string(),
  key: z.string(),
  granted: z.boolean(),
  implied: z.boolean(),
});
export type MemberPermission = z.infer<typeof MemberPermission>;

export const SetPermissionRequest = z.object({
  moduleId: ModuleId,
  key: z.string().min(1).max(64),
  granted: z.boolean(),
});
export type SetPermissionRequest = z.infer<typeof SetPermissionRequest>;

export const StartingModules = z.array(ModuleId).max(64).optional();
