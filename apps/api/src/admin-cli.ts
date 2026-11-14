import 'reflect-metadata';
import { pathToFileURL } from 'node:url';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { EnvModule } from './app.module.ts';
import { loadEnv } from './config/env.ts';
import { DatabaseModule } from './database/database.module.ts';
import { PasswordResetLinks } from './members/password-reset-links.service.ts';

const CLI_ACTOR = { userId: 'host-cli', via: 'cli' } as const;
const USAGE = 'Usage: admin-cli reset-password <email>';

export interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export async function runResetPassword(
  links: PasswordResetLinks,
  email: string,
): Promise<CliResult> {
  const userId = await links.userIdByEmail(email);
  if (!userId) return { exitCode: 1, stdout: '', stderr: 'No account with that email.' };
  const { url } = await links.issue(userId, null, CLI_ACTOR);
  return { exitCode: 0, stdout: url, stderr: '' };
}

@Module({})
class CliModule {
  static register(env: ReturnType<typeof loadEnv>) {
    return {
      module: CliModule,
      imports: [EnvModule.register(env), DatabaseModule],
      providers: [PasswordResetLinks],
    };
  }
}

async function main(argv: string[]): Promise<number> {
  const [command, email] = argv;
  if (command !== 'reset-password' || !email) {
    console.error(USAGE);
    return 2;
  }
  const ctx = await NestFactory.createApplicationContext(CliModule.register(loadEnv()), {
    logger: false,
  });
  try {
    const out = await runResetPassword(ctx.get(PasswordResetLinks), email);
    if (out.stdout) console.log(out.stdout);
    if (out.stderr) console.error(out.stderr);
    return out.exitCode;
  } finally {
    await ctx.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err: unknown) => {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    },
  );
}
