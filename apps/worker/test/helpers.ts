import { randomBytes } from 'node:crypto';
import { loadEnv, migrateJobs, type Env } from '@briefroom/api/worker-kit';
import { authSchema, scopedInsert, workspaceModules, type Db } from '@briefroom/db';
import { createTestDb, type TestDb } from '@briefroom/db/testing';
import { systemScope } from '@briefroom/module-kit';
import { TESTKIT_SQL_PATH } from '@briefroom/module-testkit/sql';

export interface Fixture {
  testDb: TestDb;
  db: Db;
  env: Env;
}

/** A test database with the app-side migrations done, pg-boss included, as a running app leaves it. */
export async function createFixture(dataDir: string, withJobsSchema = true): Promise<Fixture> {
  const testDb = await createTestDb({ extraSqlFiles: [TESTKIT_SQL_PATH] });
  try {
    if (withJobsSchema) await migrateJobs(testDb.url);
  } catch (err) {
    await testDb.close();
    throw err;
  }
  const env = loadEnv({ DATABASE_URL: testDb.url, BRIEFROOM_DATA_DIR: dataDir });
  return { testDb, db: testDb.db, env };
}

/** Better Auth workspace ids are 32 random letters and digits. */
export function newWorkspaceId(): string {
  return randomBytes(32).toString('hex').slice(0, 32);
}

export async function createWorkspace(
  db: Db,
  options: { testkitOn?: boolean } = {},
): Promise<string> {
  const id = newWorkspaceId();
  await db
    .insert(authSchema.organization)
    .values({ id, name: 'Test', slug: id, createdAt: new Date() });
  if (options.testkitOn) {
    await db
      .insert(workspaceModules)
      .values(scopedInsert(systemScope(id), { moduleId: 'testkit', enabled: true, settings: {} }));
  }
  return id;
}

export async function createNote(db: Db, workspaceId: string, text = 'ping'): Promise<string> {
  const { rows } = await db.$client.query<{ id: string }>(
    `INSERT INTO testkit_notes (workspace_id, text, created_by, created_via, updated_by, updated_via)
     VALUES ($1, $2, 'test', 'cli', 'test', 'cli') RETURNING id`,
    [workspaceId, text],
  );
  return rows[0]!.id;
}

export async function readNote(
  db: Db,
  noteId: string,
): Promise<{ text: string; updatedBy: string; updatedVia: string }> {
  const { rows } = await db.$client.query<{ text: string; updatedBy: string; updatedVia: string }>(
    `SELECT text, updated_by AS "updatedBy", updated_via AS "updatedVia" FROM testkit_notes WHERE id = $1`,
    [noteId],
  );
  return rows[0]!;
}

/** Polls until `read` returns something other than undefined. */
export async function until<T>(
  read: () => Promise<T | undefined>,
  timeoutMs: number,
  what: string,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) {
      throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
