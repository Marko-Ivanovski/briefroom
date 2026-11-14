import 'reflect-metadata';
import { createDb, runMigrations } from '@briefroom/db';
import { NestFactory } from '@nestjs/core';
import { NodeAdapter } from '@nestjs/platform-node';
import { AppModule } from './app.module.ts';
import { configureApp } from './bootstrap.ts';
import { loadEnv } from './config/env.ts';

async function main(): Promise<void> {
  const env = loadEnv();

  const db = createDb(env.databaseUrl);
  try {
    await runMigrations(db);
  } finally {
    await db.$client.end();
  }

  const app = await NestFactory.create(AppModule.register(env), new NodeAdapter());
  configureApp(app);
  await app.listen(env.port, env.host);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
