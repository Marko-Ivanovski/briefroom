import { boolean, index, pgTable, text, unique, uuid } from 'drizzle-orm/pg-core';
import { auditColumns } from '../audit.ts';
import { organization } from './auth.ts';
import { projects, projectToolLinks } from './projects.ts';

export const CHECKLIST_KINDS = ['add', 'remove'] as const;
export type ChecklistKind = (typeof CHECKLIST_KINDS)[number];

// No FK on user_id: the `remove` checklist must outlive the person's account and membership.
export const projectAccessChecklist = pgTable(
  'project_access_checklist',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    userId: text('user_id').notNull(),
    toolLinkId: uuid('tool_link_id')
      .notNull()
      .references(() => projectToolLinks.id, { onDelete: 'cascade' }),
    kind: text('kind').$type<ChecklistKind>().notNull(),
    done: boolean('done').notNull().default(false),
    ...auditColumns(),
  },
  (t) => [
    unique('project_access_checklist_item_key').on(t.projectId, t.userId, t.toolLinkId, t.kind),
    index('project_access_checklist_workspace_id_idx').on(t.workspaceId),
  ],
);
