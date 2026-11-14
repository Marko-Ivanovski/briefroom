import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestDb } from '@briefroom/db/testing';
import { moduleEnabledGuard, type ModuleManifest } from '@briefroom/module-kit';
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

type ModuleRef = unknown;

/** A Nest module reference as it appears in `imports`: a class, a dynamic module or a forwardRef. */
function resolveModuleRef(ref: ModuleRef): object | undefined {
  if (typeof ref === 'function') return ref;
  if (!ref || typeof ref !== 'object') return undefined;
  const r = ref as { forwardRef?: () => ModuleRef; module?: object };
  if (r.forwardRef) return resolveModuleRef(r.forwardRef());
  if (!r.module) return undefined;
  return r.module;
}

/** Every controller of a Nest module and of everything it imports, following dynamic modules and forwardRef. */
function moduleControllers(root: ModuleRef): object[] {
  const seen = new Set<object>();
  const controllers = new Set<object>();
  const visit = (ref: ModuleRef): void => {
    const cls = resolveModuleRef(ref);
    if (!cls || seen.has(cls)) return;
    seen.add(cls);
    for (const c of Reflect.getMetadata('controllers', cls) ?? []) controllers.add(c);
    for (const i of Reflect.getMetadata('imports', cls) ?? []) visit(i);
    if (typeof ref === 'object' && ref) {
      const dynamic = ref as { controllers?: object[]; imports?: ModuleRef[] };
      for (const c of dynamic.controllers ?? []) controllers.add(c);
      for (const i of dynamic.imports ?? []) visit(i);
    }
  };
  visit(root);
  return [...controllers];
}

/** One message per controller that is mounted outside `m/<id>` or lacks the module's guard. */
function controllerProblems(root: ModuleRef, id: string): string[] {
  const prefix = `v1/workspaces/:workspaceId/m/${id}`;
  const guard = moduleEnabledGuard(id);
  return moduleControllers(root).flatMap((c) => {
    const name = (c as { name: string }).name;
    const raw: unknown = Reflect.getMetadata(PATH_METADATA, c);
    const paths = (Array.isArray(raw) ? raw : [raw]).map(String);
    const problems = paths
      .filter((p) => p !== prefix && !p.startsWith(`${prefix}/`))
      .map((p) => `${name}: path "${p}" is outside ${prefix}`);
    const guards: unknown[] = Reflect.getMetadata(GUARDS_METADATA, c) ?? [];
    if (!guards.includes(guard)) problems.push(`${name}: missing the ${id} module-enabled guard`);
    return problems;
  });
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
        expect(moduleControllers(nestModule).length).toBeGreaterThan(0);
        expect(controllerProblems(nestModule, id)).toEqual([]);
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

  describe('the controller check', () => {
    const P = 'v1/workspaces/:workspaceId/m/design';
    const guard = moduleEnabledGuard('design');
    function controller(path: string | string[], guards: object[] = [guard]) {
      class C {}
      Reflect.defineMetadata(PATH_METADATA, path, C);
      Reflect.defineMetadata(GUARDS_METADATA, guards, C);
      return C;
    }
    function nest(controllers: object[], imports: unknown[] = []) {
      class M {}
      Reflect.defineMetadata('controllers', controllers, M);
      Reflect.defineMetadata('imports', imports, M);
      return M;
    }

    it('passes a guarded controller at the prefix and below it', () => {
      expect(
        controllerProblems(nest([controller(P), controller(`${P}/boards`)]), 'design'),
      ).toEqual([]);
    });

    it('follows imports, dynamic modules and forwardRef', () => {
      const bad = controller(P, []);
      expect(controllerProblems(nest([], [nest([bad])]), 'design')).toHaveLength(1);
      expect(controllerProblems(nest([], [{ module: nest([bad]) }]), 'design')).toHaveLength(1);
      expect(
        controllerProblems(nest([], [{ forwardRef: () => nest([bad]) }]), 'design'),
      ).toHaveLength(1);
      expect(
        controllerProblems(nest([], [{ module: nest([]), controllers: [bad] }]), 'design'),
      ).toHaveLength(1);
    });

    it('checks every element of an array path', () => {
      expect(controllerProblems(nest([controller([P, 'v1/other'])]), 'design')).toHaveLength(1);
    });

    it('requires the prefix to end at a segment boundary', () => {
      expect(controllerProblems(nest([controller(`${P}x`)]), 'design')).toHaveLength(1);
    });

    it('compares the guard by identity, not by name', () => {
      class ModuleEnabledGuard {}
      expect(
        controllerProblems(nest([controller(P, [ModuleEnabledGuard])]), 'design'),
      ).toHaveLength(1);
      expect(
        controllerProblems(nest([controller(P, [moduleEnabledGuard('other')])]), 'design'),
      ).toHaveLength(1);
    });
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
