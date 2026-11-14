import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';

export type Db = NodePgDatabase & { $client: pg.Pool };

export function createDb(url: string): Db {
  const pool = new pg.Pool({ connectionString: url, connectionTimeoutMillis: 10_000 });
  pool.on('error', (err) => {
    console.error('Postgres pool error (idle client)', err);
  });
  return drizzle({ client: pool });
}
