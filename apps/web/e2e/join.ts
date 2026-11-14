import { expect, type Browser, type Page } from '@playwright/test';

export interface Account {
  name: string;
  email: string;
  password: string;
}

export async function signIn(page: Page, account: Account): Promise<void> {
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill(account.email);
  await page.getByLabel('Password').fill(account.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/w\/[^/]+$/);
}

export const OWNER_STATE = 'e2e/.auth/owner.json';

// Contexts made with browser.newContext() inherit the owner's session unless told otherwise.
export const ANONYMOUS = { cookies: [], origins: [] };

// The owner signs in once in auth.setup.ts, so specs that use OWNER_STATE start already signed in.
export async function openWorkspace(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page).toHaveURL(/\/w\/[^/]+$/);
}

// The link is shown once, right after creation, so this returns it for the caller to use.
export async function createInviteLink(
  page: Page,
  options: { projects?: string[]; requiresApproval?: boolean; role?: 'admin' } = {},
): Promise<string> {
  await page.getByRole('link', { name: 'Invites' }).click();
  await expect(page.getByRole('heading', { name: 'Invite links' })).toBeVisible();
  for (const project of options.projects ?? []) {
    await page.getByRole('checkbox', { name: project }).check();
  }
  if (options.role) await page.getByLabel('Role').selectOption(options.role);
  if (options.requiresApproval) await page.getByLabel('Requires approval').check();
  const response = page.waitForResponse(
    (r) => r.url().endsWith('/invites') && r.request().method() === 'POST',
  );
  await page.getByRole('button', { name: 'Create invite link' }).click();
  const apiUrl = ((await (await response).json()) as { url: string }).url;
  const created = page.getByRole('region', { name: 'New invite link' });
  const url = await created.getByRole('textbox', { name: 'Invite link' }).inputValue();
  expect(url).toBe(apiUrl);
  expect(url).toMatch(/\/join\/.+/);
  return url;
}

export async function signUpThroughInvite(
  browser: Browser,
  baseURL: string | undefined,
  url: string,
  account: Account,
): Promise<{ page: Page; close: () => Promise<void> }> {
  const context = await browser.newContext({ baseURL, storageState: ANONYMOUS });
  const page = await context.newPage();
  await page.goto(url);
  await page.getByLabel('Name').fill(account.name);
  await page.getByLabel('Email').fill(account.email);
  await page.getByLabel('Password').fill(account.password);
  await page.getByRole('button', { name: 'Join workspace' }).click();
  return { page, close: () => context.close() };
}
