import { boolean, jsonb, pgTable, primaryKey, text } from 'drizzle-orm/pg-core';
import { auditColumns } from '../audit.ts';
import { organization } from './auth.ts';

// A missing row means the module is off. Switching off keeps the module's own data.
export const workspaceModules = pgTable(
  'workspace_modules',
  {
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    moduleId: text('module_id').notNull(),
    enabled: boolean('enabled').notNull().default(false),
    settings: jsonb('settings').$type<Record<string, unknown>>().notNull().default({}),
    ...auditColumns(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.moduleId] })],
);
