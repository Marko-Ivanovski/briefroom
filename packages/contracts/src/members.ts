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
