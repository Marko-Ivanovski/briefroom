import { test as setup } from '@playwright/test';
import { OWNER } from './accounts.ts';
import { OWNER_STATE, signIn } from './join.ts';

setup.use({ baseURL: process.env.E2E_BASE_URL });

setup('sign the owner in once', async ({ page }) => {
  await signIn(page, OWNER);
  await page.context().storageState({ path: OWNER_STATE });
});
