import { z } from 'zod';

export const ProjectStatus = z.enum(['active', 'paused', 'done']);
export type ProjectStatus = z.infer<typeof ProjectStatus>;

export const ToolLinkInput = z.object({
  label: z.string().trim().min(1).max(40),
  // http and https only: a stored javascript: or data: link would run when someone clicks it.
  url: z.url({ protocol: /^https?$/ }).max(2000),
});
export type ToolLinkInput = z.infer<typeof ToolLinkInput>;

const name = z.string().trim().min(1).max(80);
const emptyToNull = (v: string): string | null => (v === '' ? null : v);
const client = z.string().trim().max(80).transform(emptyToNull);
const summary = z.string().trim().max(500).transform(emptyToNull);
const ticketKey = z.string().regex(/^[A-Z][A-Z0-9]{1,9}$/);
const repoRemotes = z.array(z.string().max(500)).max(10);
const toolLinks = z.array(ToolLinkInput).max(20);

export const ProjectInput = z.object({
  name,
  client: client.optional(),
  summary: summary.optional(),
  status: ProjectStatus.default('active'),
  ticketKey: ticketKey.optional(),
  isClientWork: z.boolean().default(false),
  repoRemotes: repoRemotes.default([]),
  toolLinks: toolLinks.default([]),
});
export type ProjectInput = z.infer<typeof ProjectInput>;

// Not derived from ProjectInput.partial(): the defaults there would overwrite fields the caller left out.
export const ProjectPatch = z.object({
  name: name.optional(),
  client: client.nullable().optional(),
  summary: summary.nullable().optional(),
  status: ProjectStatus.optional(),
  ticketKey: ticketKey.nullable().optional(),
  isClientWork: z.boolean().optional(),
  repoRemotes: repoRemotes.optional(),
  toolLinks: toolLinks.optional(),
});
export type ProjectPatch = z.infer<typeof ProjectPatch>;

export const ProjectSummary = z.object({
  id: z.string(),
  name: z.string(),
  client: z.string().nullable(),
  summary: z.string().nullable(),
  status: ProjectStatus,
  ticketKey: z.string().nullable(),
  isClientWork: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ProjectSummary = z.infer<typeof ProjectSummary>;

export const ProjectDetail = ProjectSummary.extend({
  repoRemotes: z.array(z.object({ original: z.string(), normalized: z.string() })),
  toolLinks: z.array(z.object({ id: z.string(), label: z.string(), url: z.string() })),
});
export type ProjectDetail = z.infer<typeof ProjectDetail>;

export const WorkspaceSettings = z.object({ membersCanCreateProjects: z.boolean() });
export type WorkspaceSettings = z.infer<typeof WorkspaceSettings>;
