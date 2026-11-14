import { z } from 'zod';
import { Role } from './workspaces.ts';

export const MemberSummary = z.object({
  userId: z.string(),
  name: z.string(),
  email: z.string(),
  role: Role,
  joinedAt: z.iso.datetime(),
});
export type MemberSummary = z.infer<typeof MemberSummary>;

export const ChangeRoleRequest = z.object({ role: z.enum(['admin', 'member']) });
export type ChangeRoleRequest = z.infer<typeof ChangeRoleRequest>;

export const ResetLinkResponse = z.object({ url: z.string(), expiresAt: z.iso.datetime() });
export type ResetLinkResponse = z.infer<typeof ResetLinkResponse>;

export const ResetPasswordRequest = z.object({ password: z.string().min(12).max(128) });
export type ResetPasswordRequest = z.infer<typeof ResetPasswordRequest>;
