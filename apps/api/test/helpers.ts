import { fileURLToPath } from 'node:url';
import { NodeAdapter } from '@nestjs/platform-node';
import { install } from '@briefroom/db';
import { TESTKIT_SQL_PATH } from '@briefroom/module-testkit/sql';
import { createTestDb, type TestDb } from '@briefroom/db/testing';
import type { INestApplication, Type } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ThrottlerStorage, type ThrottlerStorageService } from '@nestjs/throttler';
import { AppModule } from '../src/app.module.ts';
import { AUTH } from '../src/auth/auth.module.ts';
import type { Auth } from '../src/auth/auth.ts';
import { configureApp } from '../src/bootstrap.ts';
import { loadEnv } from '../src/config/env.ts';
import { RefusedAttemptLimiter } from '../src/rate-limit/rate-limit.ts';
import { InstallService } from '../src/install/install.service.ts';
import type { SpawnChild } from '../src/remote-access/supervisor.ts';

const FIXTURE_WEB_DIR = fileURLToPath(new URL('./fixtures/web', import.meta.url));

export interface TestApp {
  app: INestApplication;
  db: TestDb;
  auth: Auth;
  close(): Promise<void>;
  reopen(spawnChild?: SpawnChild): Promise<TestApp>;
}

/** Forgets every throttle hit, so a test starts with full headroom instead of the last test's leftovers. */
export function resetThrottle(t: TestApp): void {
  const storage = t.app.get<ThrottlerStorageService>(ThrottlerStorage);
  storage.storage.clear();
  (storage as unknown as { hitExpirations: Map<string, unknown> }).hitExpirations.clear();
  t.app.get(RefusedAttemptLimiter).reset();
}

export async function makeInstallOwner(t: TestApp, userId: string): Promise<void> {
  await t.db.db.update(install).set({ ownerUserId: userId });
}

export async function createTestApp(
  envOverrides: Record<string, string> = {},
  extraControllers: Type[] = [],
  extraImports: Type[] = [],
  accessAtRoot = true,
  spawnChild?: SpawnChild,
): Promise<TestApp> {
  const db = await createTestDb({
    extraSqlFiles: process.env.BRIEFROOM_TESTKIT === '1' ? [TESTKIT_SQL_PATH] : [],
  });
  const env = loadEnv({
    DATABASE_URL: db.url,
    BRIEFROOM_PUBLIC_URL: 'http://localhost:4300',
    BRIEFROOM_WEB_DIR: FIXTURE_WEB_DIR,
    ...envOverrides,
  });
  const open = async (spawn: SpawnChild | undefined): Promise<TestApp> => {
    const app = await NestFactory.create(
      AppModule.register(env, extraControllers, extraImports, accessAtRoot, spawn),
      new NodeAdapter(),
      {
        logger: false,
        bodyParser: false,
      },
    );
    configureApp(app);
    await app.init();
    await app.get(InstallService).ensureInstall();
    return {
      app,
      db,
      auth: app.get<Auth>(AUTH),
      async close() {
        await app.close();
        await db.close();
      },
      // A new app on the same database, as after a restart. Close this app first with app.close().
      reopen: open,
    };
  };
  try {
    return await open(spawnChild);
  } catch (err) {
    await db.close();
    throw err;
  }
}
