import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { ANONYMOUS, signIn } from './join.ts';

test.use({ baseURL: process.env.E2E_BASE_URL });

// Joined through an invite in invites.spec.ts and still a plain member, so these specs also cover
// the member role.
const MEMBER = {
  name: 'Linus',
  email: 'linus@example.com',
  password: 'a third long passphrase',
};
const ACCEPT = 'application/json, text/event-stream';
const DEVICE = 'e2e-laptop';

interface Started {
  code: string;
  pollToken: string;
}

// Sign-ins are rate limited per IP, so the member signs in once and the other tests reuse the session.
let memberState: Awaited<ReturnType<BrowserContext['storageState']>>;

test.beforeAll(async ({ browser }) => {
  const context = await browser.newContext({
    baseURL: process.env.E2E_BASE_URL,
    storageState: ANONYMOUS,
  });
  await signIn(await context.newPage(), MEMBER);
  memberState = await context.storageState();
  await context.close();
});

async function memberPage(browser: Browser): Promise<{ page: Page; close: () => Promise<void> }> {
  const context = await browser.newContext({
    baseURL: process.env.E2E_BASE_URL,
    storageState: memberState,
  });
  const page = await context.newPage();
  await page.goto('/');
  await expect(page).toHaveURL(/\/w\/[^/]+$/);
  return { page, close: () => context.close() };
}

async function startLogin(baseURL: string): Promise<Started> {
  const res = await fetch(`${baseURL}/api/v1/cli-login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ deviceName: DEVICE }),
  });
  expect(res.status).toBe(201);
  return (await res.json()) as Started;
}

async function poll(
  baseURL: string,
  pollToken: string,
): Promise<{ status: string; token?: string }> {
  const res = await fetch(`${baseURL}/api/v1/cli-login/poll`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pollToken }),
  });
  return (await res.json()) as { status: string; token?: string };
}

async function whoami(baseURL: string, token: string): Promise<string> {
  const res = await fetch(`${baseURL}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: ACCEPT,
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'briefroom_whoami', arguments: {} },
    }),
  });
  expect(res.status).toBe(200);
  return res.text();
}

test('a CLI login is approved on /connect and the token works', async ({ browser }) => {
  const baseURL = process.env.E2E_BASE_URL!;
  const started = await startLogin(baseURL);
  const { page, close } = await memberPage(browser);

  await page.goto(`/connect?code=${started.code}`);
  const input = page.getByLabel('Code from your terminal');
  await expect(input).toHaveValue('');

  await input.fill('zzzz-zzzz');
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('alert')).toHaveText("That code isn't valid or has expired.");

  await input.fill(started.code.toLowerCase().replace('-', ''));
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByText(DEVICE)).toBeVisible();
  await expect(
    page.getByText('Only approve this if you just ran briefroom login yourself.'),
  ).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Approve this login' })).toBeFocused();
  await expect(page.getByRole('button', { name: 'Approve' })).toBeDisabled();
  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(input).toBeFocused();
  await input.fill(started.code);
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('heading', { name: 'Approve this login' })).toBeFocused();

  await page.getByLabel('Workspace').selectOption({ index: 1 });
  await page.getByRole('button', { name: 'Approve' }).click();
  await expect(page.getByRole('heading', { name: 'Connected' })).toBeFocused();
  await expect(page.getByRole('status')).toContainText('Connected');
  await expect(page.getByRole('status')).toContainText('return to your terminal');

  const result = await poll(baseURL, started.pollToken);
  expect(result.status).toBe('approved');
  expect(await whoami(baseURL, result.token!)).toContain('Linus');
  await close();
});

test('an anonymous visitor to /connect signs in and comes back without a code', async ({
  browser,
}) => {
  const started = await startLogin(process.env.E2E_BASE_URL!);
  const context = await browser.newContext({
    baseURL: process.env.E2E_BASE_URL,
    storageState: ANONYMOUS,
  });
  const page = await context.newPage();
  await page.goto(`/connect?code=${started.code}`);
  await expect(page).toHaveURL(/\/sign-in/);
  expect(page.url()).not.toContain(started.code);
  await page.getByLabel('Email').fill(MEMBER.email);
  await page.getByLabel('Password').fill(MEMBER.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/connect$/);
  await expect(page.getByLabel('Code from your terminal')).toHaveValue('');
  await context.close();
});

test('tokens are shown once, listed without the key and revoked after confirmation', async ({
  browser,
}) => {
  const { page, close } = await memberPage(browser);
  await page.getByRole('link', { name: 'Tokens' }).click();
  await expect(page.getByRole('heading', { name: 'Access tokens' })).toBeVisible();

  await page.getByLabel('Token name').fill('ci-box');
  await page.getByRole('button', { name: 'Create token' }).click();
  const panel = page.getByRole('region', { name: 'New token' });
  const token = await panel.getByRole('textbox', { name: 'Token' }).inputValue();
  expect(token).toMatch(/^brf_/);
  await expect(panel).toContainText("won't be shown again");

  const row = page.getByRole('row', { name: /ci-box/ });
  await expect(row).toBeVisible();
  await expect(row).not.toContainText(token);
  const stored = await page.evaluate(() =>
    JSON.stringify([{ ...localStorage }, { ...sessionStorage }, location.href]),
  );
  expect(stored).not.toContain(token);

  await page.reload();
  await expect(page.getByRole('region', { name: 'New token' })).toHaveCount(0);
  await expect(page.getByText(token)).toHaveCount(0);
  await expect(row).toBeVisible();

  await page.getByRole('button', { name: 'Revoke ci-box' }).click();
  await page.getByRole('button', { name: 'Confirm revoke ci-box' }).click();
  await expect(page.getByRole('row', { name: /ci-box/ })).toHaveCount(0);
  await close();
});
