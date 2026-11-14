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

export const JoinSignUp = z.object({
  name: z.string().trim().min(1).max(80),
  email: z.email().max(254),
  password: z.string().min(12).max(128),
});
export type JoinSignUp = z.infer<typeof JoinSignUp>;

export const JoinResult = z.discriminatedUnion('status', [
  z.object({ status: z.literal('joined'), workspaceId: z.string() }),
  z.object({ status: z.literal('pending') }),
]);
export type JoinResult = z.infer<typeof JoinResult>;

export const JoinRequestSummary = z.object({
  id: z.string(),
  userId: z.string(),
  name: z.string(),
  email: z.string(),
  role: InviteRole,
  requestedAt: z.string(),
  emailVerified: z.boolean(),
});
export type JoinRequestSummary = z.infer<typeof JoinRequestSummary>;
