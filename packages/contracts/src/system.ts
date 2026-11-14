import { z } from 'zod';

export const VersionResponse = z.object({
  api: z.literal('1'),
  app: z.string(),
  installId: z.string().nullable(),
});
export type VersionResponse = z.infer<typeof VersionResponse>;
