import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    pool: 'forks',
    maxWorkers: 4,
    testTimeout: 20_000,
    hookTimeout: 30_000,
    globalSetup: './test/global-setup.ts',
  },
});
