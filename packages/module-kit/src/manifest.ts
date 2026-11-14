import type { PgTable } from 'drizzle-orm/pg-core';
import type { ZodObject } from 'zod';

export interface ModulePermission {
  key: string;
  label: string;
  description: string;
}

export type ContentLevel = 'workspace' | 'project';

export interface ModuleManifest {
  id: string;
  name: string;
  version: string;
  description: string;
  permissions: ModulePermission[];
  contentLevels: ContentLevel[];
  /** Every table the module owns. The module contract test checks each one. */
  tables: PgTable[];
  /** Names of the module's own tables that keep a change history. Opt-in: a table not listed has none. */
  historyTables?: string[];
  /** Per-workspace settings. Every field needs a default. */
  settings?: ZodObject;
}
