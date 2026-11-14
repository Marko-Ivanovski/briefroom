import { expect, test } from '@playwright/test';

const NAME = 'Ada';
const EMAIL = 'ada@example.com';
const PASSWORD = 'correct horse battery';
const WORKSPACE = `${NAME}'s workspace`;

test.use({ baseURL: process.env.E2E_BASE_URL });

test('first run: setup, sign out, sign in, switcher and members', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveURL(/\/setup$/);

  await page.getByLabel('Setup code').fill(process.env.E2E_SETUP_CODE ?? '');
  await page.getByLabel('Name').fill(NAME);
  await page.getByLabel('Email').fill(EMAIL);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Create workspace' }).click();

  const switcher = page.getByRole('button', { name: WORKSPACE });
  await expect(switcher).toBeVisible();
  const workspaceUrl = page.url();
  expect(workspaceUrl).toMatch(/\/w\/[^/]+$/);

  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/sign-in$/);

  await page.getByLabel('Email').fill(EMAIL);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('button', { name: WORKSPACE })).toBeVisible();
  expect(page.url()).toBe(workspaceUrl);

  await page.getByRole('button', { name: WORKSPACE }).click();
  await expect(page.getByRole('menuitem', { name: 'New workspace' })).toBeVisible();
  await page.keyboard.press('Escape');

  await page.getByRole('link', { name: 'Members' }).click();
  const row = page.getByRole('row', { name: new RegExp(EMAIL) });
  await expect(row).toBeVisible();
  await expect(row.getByRole('cell', { name: 'Owner' })).toBeVisible();
});

test('a reset link that no longer works says so', async ({ page }) => {
  await page.goto('/reset/not-a-real-token');
  await page.getByLabel('New password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Set password' }).click();
  await expect(page.getByRole('alert')).toHaveText('This reset link no longer works.');
});
