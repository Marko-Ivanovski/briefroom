import { expect, test } from '@playwright/test';
import { MEMBER, OWNER } from './accounts.ts';
import { createInviteLink, signIn, signUpThroughInvite } from './join.ts';

test.use({ baseURL: process.env.E2E_BASE_URL });

test('owner manages project access, member sees only their project', async ({ page, browser }) => {
  await signIn(page, OWNER);
  const inviteUrl = await createInviteLink(page);
  const joined = await signUpThroughInvite(browser, process.env.E2E_BASE_URL, inviteUrl, MEMBER);
  await expect(joined.page).toHaveURL(/\/w\/[^/]+$/);
  await joined.close();

  await page.getByRole('link', { name: 'Projects' }).click();
  await expect(page.getByRole('heading', { name: 'Projects' })).toBeVisible();

  await page.getByRole('link', { name: 'New project' }).click();
  await page.getByLabel('Name', { exact: true }).fill('Alpha');
  await page.getByLabel('Client').fill('Acme');
  await page.getByRole('button', { name: 'Add repo remote' }).click();
  await page.getByLabel('Repo remote 1').fill('git@github.com:acme/alpha.git');
  await page.getByRole('button', { name: 'Add tool link' }).click();
  await page.getByLabel('Tool link 1 label').fill('Repo');
  await page.getByLabel('Tool link 1 URL').fill('https://github.com/acme/alpha');
  await page.getByRole('button', { name: 'Add tool link' }).click();
  await page.getByLabel('Tool link 2 label').fill('Board');
  await page.getByLabel('Tool link 2 URL').fill('https://acme.atlassian.net/board');
  await page.getByRole('button', { name: 'Create project' }).click();

  await expect(page.getByRole('heading', { name: 'Alpha' })).toBeVisible();
  await expect(page.getByText('git@github.com:acme/alpha.git')).toBeVisible();
  const repoLink = page.getByRole('link', { name: 'Repo', exact: true });
  await expect(repoLink).toHaveAttribute('rel', 'noopener noreferrer');
  await expect(repoLink).toHaveAttribute('target', '_blank');

  await page.getByRole('link', { name: 'Projects' }).click();
  await page.getByRole('link', { name: 'New project' }).click();
  await page.getByLabel('Name', { exact: true }).fill('Beta');
  await page.getByRole('button', { name: 'Create project' }).click();
  await expect(page.getByRole('heading', { name: 'Beta' })).toBeVisible();

  await page.getByRole('link', { name: 'Projects' }).click();
  await expect(page.getByRole('link', { name: 'Beta' })).toBeVisible();
  await page.getByRole('link', { name: 'Alpha' }).click();
  await page.getByRole('link', { name: 'Project members' }).click();
  await page.getByLabel('Add a member').selectOption({ label: `${MEMBER.name} (${MEMBER.email})` });
  await page.getByRole('button', { name: 'Add to project' }).click();

  const checklist = page.getByRole('region', { name: `Access to add for ${MEMBER.name}` });
  await expect(checklist.getByRole('checkbox')).toHaveCount(2);
  await checklist.getByRole('checkbox', { name: 'Repo' }).click();
  await expect(checklist.getByRole('checkbox', { name: 'Repo' })).toBeChecked();
  await expect(checklist.getByText(`Done by ${OWNER.name}`)).toBeVisible();
  await expect(checklist.getByRole('checkbox', { name: 'Board' })).not.toBeChecked();

  const memberContext = await browser.newContext({ baseURL: process.env.E2E_BASE_URL });
  const memberPage = await memberContext.newPage();
  await signIn(memberPage, MEMBER);
  await memberPage.getByRole('link', { name: 'Projects' }).click();
  await expect(memberPage.getByRole('link', { name: 'Alpha' })).toBeVisible();
  await expect(memberPage.getByRole('link', { name: 'Beta' })).toHaveCount(0);
  await expect(memberPage.getByRole('link', { name: 'New project' })).toHaveCount(0);
  await memberContext.close();

  await page.reload();
  await page.getByRole('button', { name: `Checklist for ${MEMBER.name}` }).click();
  const reopened = page.getByRole('region', { name: `Access to add for ${MEMBER.name}` });
  await expect(reopened.getByRole('checkbox', { name: 'Repo' })).toBeChecked();
  await reopened.getByRole('button', { name: 'Close' }).click();

  await page.getByRole('button', { name: `Remove ${MEMBER.name}` }).click();
  await expect(page.getByRole('row', { name: new RegExp(MEMBER.email) })).toBeVisible();
  await page.getByRole('button', { name: `Confirm remove ${MEMBER.name}` }).click();
  await expect(
    page.getByRole('region', { name: `Access to remove for ${MEMBER.name}` }),
  ).toBeVisible();
  await expect(page.getByRole('row', { name: new RegExp(MEMBER.email) })).toHaveCount(0);

  const removal = page.getByRole('region', { name: `Access to remove for ${MEMBER.name}` });
  await removal.getByRole('button', { name: 'Close' }).click();
  await expect(removal).toHaveCount(0);

  const pending = page.getByRole('region', { name: 'Pending removals' });
  const entry = pending.getByRole('button', { name: `${MEMBER.name}, 2 undone` });
  await expect(entry).toBeVisible();
  await entry.click();
  await expect(removal.getByRole('checkbox')).toHaveCount(2);
  await removal.getByRole('checkbox', { name: 'Repo' }).click();
  await expect(removal.getByRole('checkbox', { name: 'Repo' })).toBeChecked();
  await expect(pending.getByRole('button', { name: `${MEMBER.name}, 1 undone` })).toBeVisible();
  await removal.getByRole('checkbox', { name: 'Board' }).click();
  await expect(removal.getByRole('checkbox', { name: 'Board' })).toBeChecked();
  await expect(pending.getByRole('button', { name: new RegExp(MEMBER.name) })).toHaveCount(0);

  // The project is gone for this caller: the page must show the error, not the cached project.
  await page.route(/\/api\/v1\/workspaces\/[^/]+\/projects\/[^/]+$/, (route) =>
    route.fulfill({
      status: 404,
      contentType: 'application/json',
      body: JSON.stringify({ message: 'Project not found' }),
    }),
  );
  await page.evaluate(() => window.dispatchEvent(new Event('visibilitychange')));
  await expect(page.getByRole('alert')).toHaveText('That project no longer exists.');
  await expect(page.getByRole('heading', { name: 'Alpha' })).toHaveCount(0);
});
