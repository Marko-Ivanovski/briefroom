import { expect, test } from '@playwright/test';
import { OWNER } from './accounts.ts';
import { createInviteLink, signIn, signUpThroughInvite } from './join.ts';

test.use({ baseURL: process.env.E2E_BASE_URL });

const NEWCOMER = {
  name: 'Linus',
  email: 'linus@example.com',
  password: 'a third long passphrase',
};
const APPLICANT = {
  name: 'Margaret',
  email: 'margaret@example.com',
  password: 'a fourth long passphrase',
};

test('owner invites someone to a project, then revokes the link', async ({
  page,
  browser,
  context,
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await signIn(page, OWNER);
  await page.getByRole('link', { name: 'Projects' }).click();
  await page.getByRole('link', { name: 'New project' }).click();
  await page.getByLabel('Name', { exact: true }).fill('Gamma');
  await page.getByRole('button', { name: 'Create project' }).click();
  await expect(page.getByRole('heading', { name: 'Gamma' })).toBeVisible();

  const url = await createInviteLink(page, { projects: ['Gamma'] });
  const created = page.getByRole('region', { name: 'New invite link' });
  await created.getByRole('button', { name: 'Copy link' }).click();
  await expect(created.getByRole('status')).toHaveText('Copied');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(url);
  await expect(created.getByRole('img', { name: 'QR code for the invite link' })).toBeVisible();

  const joined = await signUpThroughInvite(browser, process.env.E2E_BASE_URL, url, NEWCOMER);
  await expect(joined.page).toHaveURL(/\/w\/[^/]+$/);
  await joined.page.getByRole('link', { name: 'Projects' }).click();
  await expect(joined.page.getByRole('link', { name: 'Gamma' })).toBeVisible();
  await joined.close();

  // Other specs may leave links of their own, and the newest link is listed first.
  const revokeButtons = page.getByRole('button', { name: 'Revoke' });
  const before = await revokeButtons.count();
  await revokeButtons.first().click();
  await expect(revokeButtons).toHaveCount(before - 1);

  const visitor = await browser.newContext({ baseURL: process.env.E2E_BASE_URL });
  const visitorPage = await visitor.newPage();
  await visitorPage.goto(url);
  await expect(visitorPage.getByText('This invite link no longer works')).toBeVisible();
  await visitor.close();
});

test('an approval link waits for the owner, who sees the unverified email', async ({
  page,
  browser,
}) => {
  await signIn(page, OWNER);
  const url = await createInviteLink(page, { requiresApproval: true });

  const applicant = await signUpThroughInvite(browser, process.env.E2E_BASE_URL, url, APPLICANT);
  await expect(applicant.page.getByRole('status')).toContainText('waiting for approval');

  await page.getByRole('link', { name: 'Join requests' }).click();
  const row = page.getByRole('row', { name: new RegExp(APPLICANT.name) });
  await expect(row).toContainText(APPLICANT.email);
  await expect(row).toContainText('self-reported, not verified');
  await expect(page.getByText('Confirm who this is outside Briefroom')).toBeVisible();
  await row.getByRole('button', { name: `Approve ${APPLICANT.name}` }).click();
  await expect(page.getByRole('row', { name: new RegExp(APPLICANT.name) })).toHaveCount(0);

  await applicant.page.goto('/');
  await expect(applicant.page).toHaveURL(/\/w\/[^/]+$/);
  await applicant.close();
});
