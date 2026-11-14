import { fileURLToPath } from 'node:url';
import { NodeAdapter } from '@nestjs/platform-node';
import { createTestDb, type TestDb } from '@briefroom/db/testing';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module.ts';
import { configureApp } from '../src/bootstrap.ts';
import { loadEnv } from '../src/config/env.ts';

const FIXTURE_WEB_DIR = fileURLToPath(new URL('./fixtures/web', import.meta.url));

export interface TestApp {
  app: INestApplication;
  db: TestDb;
  close(): Promise<void>;
}

export async function createTestApp(): Promise<TestApp> {
  const db = await createTestDb();
  const env = loadEnv({
    DATABASE_URL: db.url,
    BRIEFROOM_PUBLIC_URL: 'http://localhost:4300',
    BRIEFROOM_WEB_DIR: FIXTURE_WEB_DIR,
  });
  try {
    const app = await NestFactory.create(AppModule.register(env), new NodeAdapter(), {
      logger: false,
    });
    configureApp(app);
    await app.init();
    return {
      app,
      db,
      async close() {
        await app.close();
        await db.close();
      },
    };
  } catch (err) {
    await db.close();
    throw err;
  }
}
