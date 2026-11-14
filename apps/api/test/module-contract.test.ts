import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getTableColumns, getTableName } from 'drizzle-orm';
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

const SPECIFIER = /(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (e.name === 'node_modules') return [];
    const full = join(dir, e.name);
    if (e.isDirectory()) return sourceFiles(full);
    return /\.(ts|tsx|mts|js|jsx|mjs)$/.test(e.name) ? [full] : [];
  });
}

/** Import specifiers in `source` (a file inside modules/<moduleId>/) that reach another module. */
function foreignModuleImports(source: string, file: string, moduleId: string): string[] {
  const offenders: string[] = [];
  for (const [, spec] of source.matchAll(SPECIFIER)) {
    if (!spec) continue;
    const pkg = /^@briefroom\/module-([^/]+)/.exec(spec);
    if (pkg) {
      if (pkg[1] !== moduleId && pkg[1] !== 'kit') offenders.push(spec);
      continue;
    }
    if (spec.startsWith('.')) {
      const parts = relative(MODULES_DIR, resolve(dirname(file), spec)).split(sep);
      if (parts[0] === '..' || (parts[0] !== moduleId && parts[0] !== undefined)) {
        offenders.push(spec);
      }
    }
  }
  return offenders;
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

      it('gives every table project_id when the module has the project content level', () => {
        if (!manifest.contentLevels.includes('project')) return;
        for (const t of manifest.tables) {
          const names = Object.values(getTableColumns(t)).map((c) => c.name);
          expect(names, `${getTableName(t)}.project_id`).toContain('project_id');
        }
      });

      it('prefixes its table names with the module id', () => {
        for (const t of manifest.tables) {
          expect(getTableName(t).startsWith(`${id}_`), getTableName(t)).toBe(true);
        }
      });

      it('imports no other module', () => {
        const files = sourceFiles(join(MODULES_DIR, id));
        expect(files.length).toBeGreaterThan(0);
        for (const file of files) {
          expect(foreignModuleImports(readFileSync(file, 'utf8'), file, id), file).toEqual([]);
        }
      });
    },
  );

  it('the import scan catches another module', () => {
    const file = join(MODULES_DIR, 'testkit', 'server', 'x.ts');
    expect(
      foreignModuleImports(`import { a } from '@briefroom/module-notes';`, file, 'testkit'),
    ).toEqual(['@briefroom/module-notes']);
    expect(
      foreignModuleImports(`export * from '../../other/manifest.ts';`, file, 'testkit'),
    ).toEqual(['../../other/manifest.ts']);
    expect(
      foreignModuleImports(
        `import x from './a.ts'; import k from '@briefroom/module-kit';`,
        file,
        'testkit',
      ),
    ).toEqual([]);
  });
});
