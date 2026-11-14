import { defineConfig } from 'drizzle-kit';
import { DEV_DATABASE_URL } from './src/dev-url.ts';

// Each real module lists its schema here so its tables join the one migration history. The runtime
// code in packages/db/src never imports modules/*, which would be a package cycle. The testkit is
// never listed (R108): its table is created by testkit.sql in tests only.
export default defineConfig({
  dialect: 'postgresql',
  schema: ['./src/schema/index.ts'],
  out: './migrations',
  dbCredentials: {
    url: process.env.DATABASE_URL || DEV_DATABASE_URL,
  },
});
