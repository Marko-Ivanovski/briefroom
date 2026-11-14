import { auditColumns } from '@briefroom/db';
import { pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineModule, ModuleManifestError, type ModuleManifest } from '../src/index.ts';

const table = pgTable('kit_things', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: text('workspace_id').notNull(),
  ...auditColumns(),
});

function manifest(overrides: Partial<ModuleManifest> = {}): ModuleManifest {
  return {
    id: 'things',
    name: 'Things',
    version: '1.0.0',
    description: 'A module for things.',
    permissions: [{ key: 'write-things', label: 'Write things', description: 'Create things.' }],
    contentLevels: ['workspace'],
    tables: [table],
    ...overrides,
  };
}

describe('defineModule', () => {
  it('returns a valid manifest unchanged', () => {
    const m = manifest({ settings: z.object({ greeting: z.string().default('hello') }) });
    expect(defineModule(m)).toBe(m);
  });

  it('rejects an id with capitals', () => {
    expect(() => defineModule(manifest({ id: 'Design' }))).toThrow(ModuleManifestError);
    expect(() => defineModule(manifest({ id: 'Design' }))).toThrow(/id/);
  });

  it('rejects duplicate permission keys', () => {
    const p = { key: 'write-things', label: 'Write', description: 'Write.' };
    expect(() => defineModule(manifest({ permissions: [p, p] }))).toThrow(
      /duplicate permission "write-things"/,
    );
  });

  it('rejects a bad permission key and a bad version', () => {
    const bad = { key: 'Write_Things', label: 'x', description: 'x' };
    expect(() => defineModule(manifest({ permissions: [bad] }))).toThrow(/permissions\.0\.key/);
    expect(() => defineModule(manifest({ version: '1.0' }))).toThrow(/version/);
  });

  it('rejects a module with no tables', () => {
    expect(() => defineModule(manifest({ tables: [] }))).toThrow(/tables/);
  });

  it('rejects a settings field without a default', () => {
    expect(() => defineModule(manifest({ settings: z.object({ greeting: z.string() }) }))).toThrow(
      /needs a default \(greeting\)/,
    );
  });
});
