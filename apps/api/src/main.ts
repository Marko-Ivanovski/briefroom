import 'reflect-metadata';
import { createDb, runMigrations } from '@briefroom/db';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NodeAdapter } from '@nestjs/platform-node';
import { AppModule } from './app.module.ts';
import { configureApp } from './bootstrap.ts';
import { loadEnv } from './config/env.ts';
import { InstallService } from './install/install.service.ts';
import { migrateJobs } from './jobs/jobs.service.ts';

async function main(): Promise<void> {
  const env = loadEnv();

  const db = createDb(env.databaseUrl);
  try {
    await runMigrations(db);
  } finally {
    await db.$client.end();
  }
  await migrateJobs(env.databaseUrl);

  const app = await NestFactory.create(AppModule.register(env), new NodeAdapter(), {
    bodyParser: false,
  });
  configureApp(app);

  const { setupCode } = await app.get(InstallService).ensureInstall();
  if (setupCode) {
    new Logger('Install').log(`Briefroom setup code: ${setupCode}  open ${env.publicUrl}/setup`);
  }
  await app.listen(env.port, env.host);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
