import { defineConfig } from 'vitest/config';

// Separate from vite.config.ts so unit tests skip the router and Tailwind plugins.
export default defineConfig({
  test: { pool: 'forks', maxWorkers: 4, include: ['src/**/*.test.ts'] },
});
