import { expect, test, type Page } from '@playwright/test';
import { openWorkspace } from './join.ts';

test.use({ baseURL: process.env.E2E_BASE_URL });

// Joined through an invite in invites.spec.ts and still a plain member. Joining again here would
// spend the join endpoints' 20 calls a minute that the other specs already use.
const MEMBER = 'Linus';
const OFF = 'This module is off in this workspace';
const nav = (page: Page) => page.getByRole('navigation', { name: 'Workspace' });
const testkitSwitch = (page: Page) => page.getByRole('switch', { name: 'Testkit' });

test('modules: navigation, settings, member permissions and the off state', async ({ page }) => {
  await openWorkspace(page);
  const workspaceUrl = page.url();
  await expect(nav(page).getByRole('link', { name: 'Testkit' })).toBeVisible();
  await nav(page).getByRole('link', { name: 'Testkit' }).click();
  await expect(page.getByText('Testkit notes')).toBeVisible();

  await nav(page).getByRole('link', { name: 'Members' }).click();
  const toggle = page.getByRole('checkbox', { name: `write-notes for ${MEMBER}` });
  await expect(toggle).not.toBeChecked();
  await toggle.check();
  await page.reload();
  await expect(toggle).toBeChecked();
  const owner = page.getByRole('checkbox', { name: /^write-notes for Ada/ });
  await expect(owner).toBeChecked();
  await expect(owner).toBeDisabled();

  await nav(page).getByRole('link', { name: 'Modules' }).click();
  await expect(page.getByText('Testkit settings panel')).toBeVisible();
  await expect(page.getByLabel('Greeting')).toHaveValue('hello');
  await page.getByLabel('Greeting').fill('ahoj');
  await page.getByRole('button', { name: 'Save greeting' }).click();
  await page.reload();
  await expect(page.getByLabel('Greeting')).toHaveValue('ahoj');
  await testkitSwitch(page).uncheck();
  await expect(nav(page).getByRole('link', { name: 'Testkit' })).toHaveCount(0);
  await expect(page.getByText('Testkit settings panel')).toHaveCount(0);

  await page.goto(`${workspaceUrl}/m/testkit`);
  await expect(page.getByText(OFF, { exact: true })).toBeVisible();

  await page.goto(`${workspaceUrl}/settings/modules`);
  await testkitSwitch(page).check();
  await expect(nav(page).getByRole('link', { name: 'Testkit' })).toBeVisible();
});

test('a new workspace offers the starting modules', async ({ page }) => {
  await openWorkspace(page);
  await page.getByRole('banner').getByRole('button').first().click();
  await page.getByRole('menuitem', { name: 'New workspace' }).click();
  await page.getByLabel('Workspace name').fill('Second');
  await expect(page.getByRole('checkbox', { name: 'Testkit' })).toBeChecked();
  await page.getByRole('checkbox', { name: 'Testkit' }).uncheck();
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await expect(page.getByRole('button', { name: 'Second' })).toBeVisible();
  await expect(nav(page).getByRole('link', { name: 'Projects' })).toBeVisible();
  await expect(nav(page).getByRole('link', { name: 'Testkit' })).toHaveCount(0);
});
