import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestDb } from '@briefroom/db/testing';
import type { ModuleManifest } from '@briefroom/module-kit';
import { TESTKIT_SQL_PATH } from '@briefroom/module-testkit/sql';
import { GUARDS_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { getTableColumns, getTableName } from 'drizzle-orm';
import { getTableConfig, pgTable, uuid, type PgTable } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import { REGISTERED_MODULES } from '../src/module-registry/registered-modules.ts';

const MODULES_DIR = fileURLToPath(new URL('../../../modules', import.meta.url));

const DB_DIR = fileURLToPath(new URL('../../../packages/db', import.meta.url));
const DRIZZLE_CONFIG = join(DB_DIR, 'drizzle.config.ts');
const MIGRATIONS_DIR = join(DB_DIR, 'migrations');
const MODULE_SCHEMA_PATH = /['"]\.\.\/\.\.\/modules\/([\w-]+)\/schema\/index\.ts['"]/g;

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

// Static scan only: specifiers built at runtime (template literals, variables, require.resolve) are not detected.
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

const allModuleDirs = readdirSync(MODULES_DIR, { withFileTypes: true })
  .filter((e) => e.isDirectory() && e.name !== 'node_modules')
  .map((e) => e.name);

const moduleDirs = allModuleDirs.filter((d) => existsSync(join(MODULES_DIR, d, 'manifest.ts')));

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

interface SnapshotRow {
  op?: string;
  row?: { entityType?: string; name?: string };
  entityType?: string;
  name?: string;
}

/** Replays the migration snapshots (one base, then diffs) into the set of tables that exist. */
function tablesInMigrationHistory(): Set<string> {
  const tables = new Set<string>();
  for (const dir of readdirSync(MIGRATIONS_DIR).sort()) {
    const file = join(MIGRATIONS_DIR, dir, 'snapshot.json');
    if (!existsSync(file)) continue;
    const snapshot = JSON.parse(readFileSync(file, 'utf8')) as {
      ddl?: SnapshotRow[];
      deltas?: SnapshotRow[];
    };
    for (const e of snapshot.ddl ?? []) {
      if (e.entityType === 'tables' && e.name) tables.add(e.name);
    }
    for (const d of snapshot.deltas ?? []) {
      if (d.row?.entityType !== 'tables' || !d.row.name) continue;
      if (d.op === 'create') tables.add(d.row.name);
      if (d.op === 'drop') tables.delete(d.row.name);
    }
  }
  return tables;
}

/** Tables a module declares that no migration creates. The testkit is exempt (R108). */
function tablesMissingFromHistory(manifests: ModuleManifest[], history: Set<string>): string[] {
  return manifests
    .filter((m) => m.id !== 'testkit')
    .flatMap((m) => m.tables.map((t) => getTableName(t)))
    .filter((name) => !history.has(name));
}

function configuredModuleSchemas(): string[] {
  return [...readFileSync(DRIZZLE_CONFIG, 'utf8').matchAll(MODULE_SCHEMA_PATH)].map((m) => m[1]!);
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

      it('mounts every controller under its own prefix, behind the module-enabled guard', () => {
        const nestModule = REGISTERED_MODULES.find((m) => m.manifest.id === id)!.nestModule;
        const controllers: object[] = Reflect.getMetadata('controllers', nestModule) ?? [];
        expect(controllers.length).toBeGreaterThan(0);
        for (const c of controllers) {
          const name = (c as { name: string }).name;
          const path = String(Reflect.getMetadata(PATH_METADATA, c));
          expect(path.startsWith(`v1/workspaces/:workspaceId/m/${id}`), name).toBe(true);
          const guards: { name: string }[] = Reflect.getMetadata(GUARDS_METADATA, c) ?? [];
          expect(
            guards.map((g) => g.name),
            name,
          ).toContain('ModuleEnabledGuard');
        }
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

  it.each(allModuleDirs)('modules/%s imports nothing outside its allowed surface', (dir) => {
    const files = sourceFiles(join(MODULES_DIR, dir));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      expect(foreignModuleImports(readFileSync(file, 'utf8'), file, dir), file).toEqual([]);
    }
  });

  it('lists every module folder except the testkit in drizzle.config.ts (R113)', () => {
    const listed = configuredModuleSchemas();
    expect(listed, 'the testkit never joins the migration history (R108)').not.toContain('testkit');
    for (const dir of moduleDirs.filter((d) => d !== 'testkit')) {
      expect(listed, `modules/${dir} is missing from drizzle.config.ts`).toContain(dir);
    }
  });

  it('has every registered module table in the migration history (R113)', () => {
    const history = tablesInMigrationHistory();
    expect(history.has('workspace_modules')).toBe(true);
    expect(
      tablesMissingFromHistory(
        REGISTERED_MODULES.map((m) => m.manifest),
        history,
      ),
    ).toEqual([]);
  });

  it('the history check flags a module table no migration creates, and exempts the testkit', () => {
    const testkit = REGISTERED_MODULES[0]!.manifest;
    const history = tablesInMigrationHistory();
    expect(tablesMissingFromHistory([testkit], history)).toEqual([]);
    const forgotten = pgTable('design_boards', { id: uuid('id').primaryKey() });
    expect(
      tablesMissingFromHistory([{ ...testkit, id: 'design', tables: [forgotten] }], history),
    ).toEqual(['design_boards']);
  });

  it('the project_id rule rejects a project-only module with a nullable project_id', () => {
    const testkit = REGISTERED_MODULES[0]!.manifest;
    expect(projectIdProblems({ ...testkit, contentLevels: ['project'] })).not.toEqual([]);
    expect(projectIdProblems({ ...testkit, contentLevels: ['workspace'] })).toEqual([]);
    expect(projectIdProblems(testkit)).toEqual([]);
  });

  it('the project_id rule rejects tables with no project_id at all', () => {
    const testkit = REGISTERED_MODULES[0]!.manifest;
    const noProjectId = pgTable('x_things', { id: uuid('id').primaryKey() });
    expect(projectIdProblems({ ...testkit, tables: [noProjectId] })).not.toEqual([]);
    expect(
      projectIdProblems({ ...testkit, contentLevels: ['project'], tables: [noProjectId] }),
    ).not.toEqual([]);
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
