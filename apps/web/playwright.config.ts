import { defineConfig, devices } from '@playwright/test';

// Both specs share one install: first-run performs the one-time setup through the UI, and
// projects depends on it, so setup happens once and the owner and workspace exist afterwards.
export default defineConfig({
  testDir: './e2e',
  globalSetup: './e2e/global-setup.ts',
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? 'github' : 'list',
  projects: [
    {
      name: 'first-run',
      testMatch: 'first-run.spec.ts',
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'projects',
      testMatch: 'projects.spec.ts',
      dependencies: ['first-run'],
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
