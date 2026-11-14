import { z } from 'zod';
import { Role } from './workspaces.ts';

export const MemberSummary = z.object({
  userId: z.string(),
  name: z.string(),
  email: z.string(),
  role: Role,
  joinedAt: z.iso.datetime(),
  emailVerified: z.boolean(),
});
export type MemberSummary = z.infer<typeof MemberSummary>;

export const ChangeRoleRequest = z.object({ role: z.enum(['admin', 'member']) });
export type ChangeRoleRequest = z.infer<typeof ChangeRoleRequest>;

export const ResetLinkResponse = z.object({ url: z.string(), expiresAt: z.iso.datetime() });
export type ResetLinkResponse = z.infer<typeof ResetLinkResponse>;

export const ResetPasswordRequest = z.object({ password: z.string().min(12).max(128) });
export type ResetPasswordRequest = z.infer<typeof ResetPasswordRequest>;

// Projects the person was on that still have access to take away, so the remover can be pointed at them.
export const RemovalResult = z.object({
  projects: z.array(z.object({ id: z.string(), name: z.string(), undone: z.number() })),
});
export type RemovalResult = z.infer<typeof RemovalResult>;
