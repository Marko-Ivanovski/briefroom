import { z } from 'zod';

export const BookmarkCreate = z.object({ inviteUrl: z.string().max(2048) });
export type BookmarkCreate = z.infer<typeof BookmarkCreate>;

export const BookmarkCreated = z.object({
  id: z.string(),
  label: z.string(),
  joinUrl: z.string(),
});
export type BookmarkCreated = z.infer<typeof BookmarkCreated>;

export const BookmarkSummary = z.object({
  id: z.string(),
  label: z.string(),
  remoteBaseUrl: z.string(),
});
export type BookmarkSummary = z.infer<typeof BookmarkSummary>;
