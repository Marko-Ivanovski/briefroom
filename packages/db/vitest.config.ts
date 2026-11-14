import { defineConfig } from 'vitest/config';

export default defineConfig({ test: { pool: 'threads', globalSetup: './test/global-setup.ts' } });
