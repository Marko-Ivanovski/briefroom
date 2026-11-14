import { sql } from 'drizzle-orm';
import { boolean, check, index, integer, pgTable, text, unique, uuid } from 'drizzle-orm/pg-core';
import { auditColumns } from '../audit.ts';
import { organization } from './auth.ts';

export const PROJECT_STATUSES = ['active', 'paused', 'done'] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

export const projects = pgTable(
  'projects',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    client: text('client'),
    summary: text('summary'),
    status: text('status').$type<ProjectStatus>().notNull().default('active'),
    ticketKey: text('ticket_key'),
    isClientWork: boolean('is_client_work').notNull().default(false),
    ...auditColumns(),
  },
  (t) => [
    index('projects_workspace_id_idx').on(t.workspaceId),
    check('projects_status_valid', sql`${t.status} in ('active', 'paused', 'done')`),
  ],
);

export const projectRemotes = pgTable(
  'project_remotes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    normalized: text('normalized').notNull(),
    original: text('original').notNull(),
    ...auditColumns(),
  },
  (t) => [
    unique('project_remotes_workspace_normalized_key').on(t.workspaceId, t.normalized),
    index('project_remotes_project_id_idx').on(t.projectId),
  ],
);

export const projectToolLinks = pgTable(
  'project_tool_links',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    label: text('label').notNull(),
    url: text('url').notNull(),
    position: integer('position').notNull(),
    ...auditColumns(),
  },
  (t) => [index('project_tool_links_project_id_idx').on(t.projectId)],
);

export const workspaceSettings = pgTable('workspace_settings', {
  workspaceId: text('workspace_id')
    .primaryKey()
    .references(() => organization.id, { onDelete: 'cascade' }),
  membersCanCreateProjects: boolean('members_can_create_projects').notNull().default(false),
  ...auditColumns(),
});
