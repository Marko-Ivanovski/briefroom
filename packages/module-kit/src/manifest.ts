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
  /** Per-workspace settings. Every field needs a default. */
  settings?: ZodObject;
}
