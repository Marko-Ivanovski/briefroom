import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestDb } from '@briefroom/db/testing';
import type { ModuleManifest } from '@briefroom/module-kit';
import { TESTKIT_SQL_PATH } from '@briefroom/module-testkit/sql';
import { getTableColumns, getTableName } from 'drizzle-orm';
import { getTableConfig, type PgTable } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import { REGISTERED_MODULES } from '../src/module-registry/registered-modules.ts';

const MODULES_DIR = fileURLToPath(new URL('../../../modules', import.meta.url));

const AUDIT = [
  'createdBy',
  'createdAt',
  'createdVia',
  'createdAgent',
  'updatedBy',
  'updatedAt',
  'updatedVia',
  'updatedAgent',
];

const SPECIFIER = /(?:from|import|require)\s*\(?\s*['"]([^'"]+)['"]/g;

const ALLOWED_CORE = ['module-kit', 'db', 'contracts'];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (e.name === 'node_modules') return [];
    const full = join(dir, e.name);
    if (e.isDirectory()) return sourceFiles(full);
    return /\.(ts|tsx|mts|js|jsx|mjs)$/.test(e.name) ? [full] : [];
  });
}

/** Specifiers in `source` (a file inside modules/<moduleId>/) that reach outside the module's allowed surface. */
function foreignModuleImports(source: string, file: string, moduleId: string): string[] {
  const offenders: string[] = [];
  for (const [, spec] of source.matchAll(SPECIFIER)) {
    if (!spec || spec.startsWith('node:')) continue;
    if (spec.startsWith('.')) {
      const parts = relative(MODULES_DIR, resolve(dirname(file), spec)).split(sep);
      if (parts[0] === '..' || parts[0] !== moduleId) offenders.push(spec);
      continue;
    }
    if (spec.startsWith('@briefroom/')) {
      const name = spec.slice('@briefroom/'.length).split('/')[0]!;
      if (!ALLOWED_CORE.includes(name) && name !== `module-${moduleId}`) offenders.push(spec);
      continue;
    }
    if (/^(apps|modules)\//.test(spec) || spec.startsWith('/')) offenders.push(spec);
  }
  return offenders;
}

const moduleDirs = readdirSync(MODULES_DIR, { withFileTypes: true })
  .filter((e) => e.isDirectory() && existsSync(join(MODULES_DIR, e.name, 'manifest.ts')))
  .map((e) => e.name);

/**
 * R109: a module that holds only project content needs a NOT NULL project_id on every table. A
 * module with both levels needs project_id on at least one table, and the others may omit it or
 * leave it nullable. A workspace-only module needs none.
 */
function projectIdProblems(manifest: ModuleManifest): string[] {
  const levels = manifest.contentLevels;
  const projectIdOf = (t: PgTable) =>
    Object.values(getTableColumns(t)).find((c) => c.name === 'project_id');
  if (levels.length === 1 && levels[0] === 'project') {
    return manifest.tables.flatMap((t) => {
      const col = projectIdOf(t);
      return col?.notNull ? [] : [`${getTableName(t)}.project_id must exist and be NOT NULL`];
    });
  }
  if (levels.includes('project')) {
    return manifest.tables.some(projectIdOf)
      ? []
      : ['a module with the project level needs project_id on at least one table'];
  }
  return [];
}

describe('module contract', () => {
  it('registers the testkit under BRIEFROOM_TESTKIT=1', () => {
    expect(REGISTERED_MODULES.map((m) => m.manifest.id)).toContain('testkit');
  });

  describe.each(REGISTERED_MODULES.map((m) => [m.manifest.id, m.manifest] as const))(
    '%s',
    (id, manifest) => {
      it('owns at least one table, each with workspace_id and the audit columns', () => {
        expect(manifest.tables.length).toBeGreaterThan(0);
        for (const t of manifest.tables) {
          const cols = Object.keys(getTableColumns(t));
          const names = Object.values(getTableColumns(t)).map((c) => c.name);
          expect(names, `${getTableName(t)}.workspace_id`).toContain('workspace_id');
          for (const c of AUDIT) expect(cols, `${getTableName(t)}.${c}`).toContain(c);
        }
      });

      it('follows the project_id rule for its content levels (R109)', () => {
        expect(projectIdProblems(manifest)).toEqual([]);
      });

      it('prefixes its table names with the module id', () => {
        for (const t of manifest.tables) {
          expect(getTableName(t).startsWith(`${id}_`), getTableName(t)).toBe(true);
        }
      });
    },
  );

  it('registers every module folder that has a manifest.ts', () => {
    const registered = REGISTERED_MODULES.map((m) => m.manifest.id);
    for (const dir of moduleDirs) expect(registered, `modules/${dir}`).toContain(dir);
  });

  it.each(moduleDirs)('modules/%s imports nothing outside its allowed surface', (dir) => {
    const files = sourceFiles(join(MODULES_DIR, dir));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      expect(foreignModuleImports(readFileSync(file, 'utf8'), file, dir), file).toEqual([]);
    }
  });

  it('the project_id rule rejects a project-only module with a nullable project_id', () => {
    const testkit = REGISTERED_MODULES[0]!.manifest;
    expect(projectIdProblems({ ...testkit, contentLevels: ['project'] })).not.toEqual([]);
    expect(projectIdProblems({ ...testkit, contentLevels: ['workspace'] })).toEqual([]);
    expect(projectIdProblems(testkit)).toEqual([]);
  });

  it('testkit.sql creates the columns the Drizzle table declares', async () => {
    const testkit = REGISTERED_MODULES.find((m) => m.manifest.id === 'testkit')!.manifest;
    const t = await createTestDb({ extraSqlFiles: [TESTKIT_SQL_PATH] });
    try {
      for (const table of testkit.tables) {
        const config = getTableConfig(table);
        const { rows } = await t.db.$client.query<{ column_name: string; is_nullable: string }>(
          `SELECT column_name, is_nullable FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = $1`,
          [config.name],
        );
        const actual = Object.fromEntries(
          rows.map((r) => [r.column_name, r.is_nullable === 'YES']),
        );
        const expected = Object.fromEntries(config.columns.map((c) => [c.name, !c.notNull]));
        expect(actual).toEqual(expected);
      }
    } finally {
      await t.close();
    }
  });

  it('the import scan flags every way out and passes the allowed imports', () => {
    const file = join(MODULES_DIR, 'testkit', 'server', 'x.ts');
    const flagged = (line: string) => foreignModuleImports(line, file, 'testkit').length > 0;
    for (const line of [
      `import { a } from '@briefroom/module-notes';`,
      `export * from '../../other/manifest.ts';`,
      `const m = await import('../../other/x');`,
      `import x from 'apps/api/x';`,
      `import x from 'modules/other/x';`,
      `import x from '@briefroom/api';`,
      `const w = require('@briefroom/web');`,
      `import x from '/abs/path';`,
    ]) {
      expect(flagged(line), line).toBe(true);
    }
    for (const line of [
      `import x from './a.ts';`,
      `import k from '@briefroom/module-kit';`,
      `import k from '@briefroom/module-kit/web';`,
      `import d from '@briefroom/db';`,
      `import c from '@briefroom/contracts';`,
      `import t from '@briefroom/module-testkit/manifest';`,
      `import { z } from 'zod';`,
      `import { fileURLToPath } from 'node:url';`,
    ]) {
      expect(flagged(line), line).toBe(false);
    }
  });
});
