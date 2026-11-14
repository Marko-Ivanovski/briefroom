import type { Db } from '@briefroom/db';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { DB } from '../src/database/database.module.ts';
import { InstallService } from '../src/install/install.service.ts';
import { createTestApp, type TestApp } from './helpers.ts';

interface LockClient {
  query: (...args: unknown[]) => Promise<unknown>;
  release: (destroy?: Error | boolean) => void;
}
type Connect = (...args: unknown[]) => Promise<LockClient> | void;

describe('setup advisory lock', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });

  afterAll(async () => {
    await t.close();
  });

  it('destroys the connection instead of pooling it when the unlock fails', async () => {
    const { setupCode } = await t.app.get(InstallService).ensureInstall();
    const pool = t.app.get<Db>(DB).$client;
    const connect = pool.connect.bind(pool) as unknown as Connect;
    const released: unknown[] = [];

    vi.spyOn(pool, 'connect').mockImplementation(((...args: unknown[]) => {
      // pool.query() calls connect(callback) internally; only the callback-less call is the lock's.
      if (args.length > 0) return connect(...args);
      return (connect() as Promise<LockClient>).then((client) => {
        const query = client.query.bind(client);
        client.query = (sql, ...rest) =>
          String(sql).includes('pg_advisory_unlock')
            ? Promise.reject(new Error('unlock failed'))
            : query(sql, ...rest);
        const release = client.release.bind(client);
        client.release = (destroy) => {
          released.push(destroy);
          release(destroy);
        };
        return client;
      });
    }) as unknown as typeof pool.connect);

    const res = await request(t.app.getHttpServer())
      .post('/api/v1/setup')
      .send({ code: setupCode, name: 'Ada', email: 'ada@example.com', password: 'correct horse' });
    vi.restoreAllMocks();

    expect(res.status).toBe(201);
    expect(released).toEqual([true]);
  });
});
