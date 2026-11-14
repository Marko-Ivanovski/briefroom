import { createDb, type Db } from '@briefroom/db';
import { Global, Inject, Injectable, Module, type OnApplicationShutdown } from '@nestjs/common';
import { ENV, type Env } from '../config/env.ts';

export const DB = Symbol('DB');

@Injectable()
class DbLifecycle implements OnApplicationShutdown {
  constructor(@Inject(DB) private readonly db: Db) {}

  async onApplicationShutdown(): Promise<void> {
    await this.db.$client.end();
  }
}

@Global()
@Module({
  providers: [
    { provide: DB, useFactory: (env: Env): Db => createDb(env.databaseUrl), inject: [ENV] },
    DbLifecycle,
  ],
  exports: [DB],
})
export class DatabaseModule {}
