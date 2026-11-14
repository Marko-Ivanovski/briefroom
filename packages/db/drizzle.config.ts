import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: ['./src/schema/**/*.ts', '../../modules/*/schema/**/*.ts'],
  out: './migrations',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgres://briefroom:briefroom@127.0.0.1:54329/briefroom_dev',
  },
});
