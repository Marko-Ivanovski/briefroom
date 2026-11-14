import { defineConfig, devices } from '@playwright/test';

// Rate budgets for one run, which the specs share. Better Auth allows 5 sign-ins a minute per IP,
// and a run makes 3 (first-run, the setup project and projects.spec). The join endpoints allow 20 calls
// a minute per IP and the existing specs use most of them, so new specs reuse the members that
// invites.spec.ts creates instead of signing up more through invites.
//
// The specs share one install: first-run performs the one-time setup through the UI, and
// the others depend on it, so setup happens once and the owner and workspace exist afterwards.
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
      name: 'setup',
      testMatch: 'auth.setup.ts',
      dependencies: ['first-run'],
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'projects',
      testMatch: 'projects.spec.ts',
      dependencies: ['setup'],
      use: { ...devices['Desktop Chrome'], storageState: 'e2e/.auth/owner.json' },
    },
    {
      name: 'invites',
      testMatch: 'invites.spec.ts',
      dependencies: ['setup'],
      use: { ...devices['Desktop Chrome'], storageState: 'e2e/.auth/owner.json' },
    },
    {
      name: 'members',
      testMatch: 'members.spec.ts',
      dependencies: ['invites'],
      use: { ...devices['Desktop Chrome'], storageState: 'e2e/.auth/owner.json' },
    },
    {
      name: 'modules',
      testMatch: 'modules.spec.ts',
      dependencies: ['members'],
      use: { ...devices['Desktop Chrome'], storageState: 'e2e/.auth/owner.json' },
    },
  ],
});
