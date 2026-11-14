import { z } from 'zod';

export const InviteRole = z.enum(['admin', 'member']);
export type InviteRole = z.infer<typeof InviteRole>;

export const InviteCreate = z.object({
  role: InviteRole.default('member'),
  expiresInDays: z.number().int().min(1).max(90).default(7),
  maxUses: z.number().int().min(1).nullable().default(null),
  requiresApproval: z.boolean().default(false),
  projectIds: z.array(z.uuid()).max(50).default([]),
});
export type InviteCreate = z.infer<typeof InviteCreate>;

export const InviteCreated = z.object({
  id: z.string(),
  url: z.string(),
  expiresAt: z.string(),
});
export type InviteCreated = z.infer<typeof InviteCreated>;

export const InviteSummary = z.object({
  id: z.string(),
  role: InviteRole,
  expiresAt: z.string(),
  maxUses: z.number().nullable(),
  uses: z.number(),
  requiresApproval: z.boolean(),
  projectIds: z.array(z.string()),
  createdBy: z.string(),
  createdAt: z.string(),
});
export type InviteSummary = z.infer<typeof InviteSummary>;

export const JoinLookup = z.discriminatedUnion('valid', [
  z.object({ valid: z.literal(false) }),
  z.object({
    valid: z.literal(true),
    workspaceName: z.string(),
    role: InviteRole,
    requiresApproval: z.boolean(),
  }),
]);
export type JoinLookup = z.infer<typeof JoinLookup>;
