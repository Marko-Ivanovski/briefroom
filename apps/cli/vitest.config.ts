import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { pool: 'forks', globals: true, root: './', testTimeout: 20_000 },
});
