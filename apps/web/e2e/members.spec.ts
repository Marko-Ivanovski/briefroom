import { expect, test, type Page } from '@playwright/test';
import { OWNER } from './accounts.ts';
import { createInviteLink, openWorkspace, signUpThroughInvite, type Account } from './join.ts';

test.use({ baseURL: process.env.E2E_BASE_URL });

const account = (name: string, password: string): Account => ({
  name,
  email: `${name.toLowerCase()}@example.com`,
  password,
});
const HOPPER = account('Hopper', 'an admin long passphrase');
const BABBAGE = account('Babbage', 'a second admin passphrase');
const TURING = account('Turing', 'a member long passphrase');
const LOVELACE = account('Lovelace', 'another member passphrase');

const removeButtons = (page: Page) => page.getByRole('button', { name: /^Remove / });
const removeButton = (page: Page, who: Account) =>
  page.getByRole('button', { name: `Remove ${who.name}` });
const leaveButton = (page: Page) => page.getByRole('button', { name: 'Leave workspace' });

async function openMembers(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page).toHaveURL(/\/w\/[^/]+$/);
  await page.getByRole('link', { name: 'Members' }).click();
  await expect(page.getByRole('heading', { name: 'Members' })).toBeVisible();
}

test('Remove and Leave follow the role, and removal and leaving end access', async ({
  page,
  browser,
}) => {
  const baseURL = process.env.E2E_BASE_URL;
  await openWorkspace(page);

  await page.getByRole('link', { name: 'Projects' }).click();
  await page.getByRole('link', { name: 'New project' }).click();
  await page.getByLabel('Name', { exact: true }).fill('Delta');
  await page.getByRole('button', { name: 'Add tool link' }).click();
  await page.getByLabel('Tool link 1 label').fill('Repo');
  await page.getByLabel('Tool link 1 URL').fill('https://github.com/acme/delta');
  await page.getByRole('button', { name: 'Create project' }).click();
  await expect(page.getByRole('heading', { name: 'Delta' })).toBeVisible();

  const adminLink = await createInviteLink(page, { role: 'admin' });
  const admins = [];
  for (const who of [HOPPER, BABBAGE]) {
    const joined = await signUpThroughInvite(browser, baseURL, adminLink, who);
    await expect(joined.page.getByRole('status')).toContainText('waiting for approval');
    admins.push(joined);
  }
  await page.getByRole('link', { name: 'Join requests' }).click();
  for (const who of [HOPPER, BABBAGE]) {
    await page.getByRole('button', { name: `Approve ${who.name}` }).click();
    await expect(page.getByRole('row', { name: new RegExp(who.name) })).toHaveCount(0);
  }

  const memberLink = await createInviteLink(page);
  const turing = await signUpThroughInvite(browser, baseURL, memberLink, TURING);
  await expect(turing.page).toHaveURL(/\/w\/[^/]+$/);
  const lovelace = await signUpThroughInvite(browser, baseURL, memberLink, LOVELACE);
  await expect(lovelace.page).toHaveURL(/\/w\/[^/]+$/);

  await page.getByRole('link', { name: 'Projects' }).click();
  await page.getByRole('link', { name: 'Delta' }).click();
  await page.getByRole('link', { name: 'Project members' }).click();
  await page.getByLabel('Add a member').selectOption({ label: `${TURING.name} (${TURING.email})` });
  await page.getByRole('button', { name: 'Add to project' }).click();
  await expect(
    page.getByRole('region', { name: `Access to add for ${TURING.name}` }),
  ).toBeVisible();

  await openMembers(page);
  await expect(removeButton(page, TURING)).toBeVisible();
  await expect(removeButton(page, HOPPER)).toBeVisible();
  await expect(removeButton(page, OWNER)).toHaveCount(0);
  await expect(leaveButton(page)).toHaveCount(0);

  const hopper = admins[0]!.page;
  await openMembers(hopper);
  await expect(removeButton(hopper, TURING)).toBeVisible();
  await expect(removeButton(hopper, OWNER)).toHaveCount(0);
  await expect(removeButton(hopper, BABBAGE)).toHaveCount(0);
  await expect(leaveButton(hopper)).toBeVisible();

  await openMembers(turing.page);
  await expect(removeButtons(turing.page)).toHaveCount(0);
  await expect(leaveButton(turing.page)).toBeVisible();
  await turing.page.getByRole('banner').getByRole('button').first().click();
  await expect(turing.page.getByRole('menuitem', { name: 'Join a workspace' })).toHaveCount(0);
  await turing.page.keyboard.press('Escape');

  await removeButton(page, TURING).click();
  await expect(page.getByText('joining again will need approval')).toBeVisible();
  await page.getByRole('button', { name: `Confirm remove ${TURING.name}` }).click();
  await expect(page.getByRole('row', { name: new RegExp(TURING.email) })).toHaveCount(0);
  const pending = page.getByRole('region', { name: 'Pending removals' });
  await expect(pending.getByRole('link', { name: 'Delta' })).toBeVisible();
  await expect(pending).toContainText('1 undone');

  await turing.page.goto('/');
  await expect(turing.page).toHaveURL(/\/sign-in$/);

  await openMembers(lovelace.page);
  await leaveButton(lovelace.page).click();
  await lovelace.page.getByRole('button', { name: 'Confirm leave' }).click();
  await expect(lovelace.page).toHaveURL(/\/(sign-in)?$/);
  await page.reload();
  await expect(page.getByRole('row', { name: new RegExp(LOVELACE.email) })).toHaveCount(0);

  for (const joined of [...admins, turing, lovelace]) await joined.close();
});
