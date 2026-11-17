import { z } from 'zod';

export const TokenCreate = z.object({ name: z.string().trim().min(1).max(80) });
export type TokenCreate = z.infer<typeof TokenCreate>;

export const TokenCreated = z.object({ id: z.string(), name: z.string(), token: z.string() });
export type TokenCreated = z.infer<typeof TokenCreated>;

export const TokenSummary = z.object({
  id: z.string(),
  name: z.string(),
  createdAt: z.iso.datetime(),
  lastUsedAt: z.iso.datetime().nullable(),
});
export type TokenSummary = z.infer<typeof TokenSummary>;
