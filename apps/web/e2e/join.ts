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

// The link is shown once, right after creation, so this returns it for the caller to use.
export async function createInviteLink(
  page: Page,
  options: { projects?: string[]; requiresApproval?: boolean } = {},
): Promise<string> {
  await page.getByRole('link', { name: 'Invites' }).click();
  await expect(page.getByRole('heading', { name: 'Invite links' })).toBeVisible();
  for (const project of options.projects ?? []) {
    await page.getByRole('checkbox', { name: project }).check();
  }
  if (options.requiresApproval) await page.getByLabel('Requires approval').check();
  await page.getByRole('button', { name: 'Create invite link' }).click();
  const created = page.getByRole('region', { name: 'New invite link' });
  const url = await created.getByRole('textbox', { name: 'Invite link' }).inputValue();
  expect(url).toMatch(/\/join\/.+/);
  return url;
}

export async function signUpThroughInvite(
  browser: Browser,
  baseURL: string | undefined,
  url: string,
  account: Account,
): Promise<{ page: Page; close: () => Promise<void> }> {
  const context = await browser.newContext({ baseURL });
  const page = await context.newPage();
  await page.goto(url);
  await page.getByLabel('Name').fill(account.name);
  await page.getByLabel('Email').fill(account.email);
  await page.getByLabel('Password').fill(account.password);
  await page.getByRole('button', { name: 'Join workspace' }).click();
  return { page, close: () => context.close() };
}
