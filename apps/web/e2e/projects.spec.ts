import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { MEMBER, OWNER } from './accounts.ts';

const API_DIR = fileURLToPath(new URL('../../api', import.meta.url));

test.use({ baseURL: process.env.E2E_BASE_URL });

test.beforeAll(() => {
  execFileSync(
    process.execPath,
    ['--import', '@swc-node/register/esm-register', 'test/seed-e2e-member.ts'],
    {
      cwd: API_DIR,
      stdio: 'inherit',
      env: {
        ...process.env,
        NODE_ENV: 'test',
        DATABASE_URL: process.env.E2E_DATABASE_URL,
        SEED_OWNER_EMAIL: OWNER.email,
        SEED_MEMBER_NAME: MEMBER.name,
        SEED_MEMBER_EMAIL: MEMBER.email,
        SEED_MEMBER_PASSWORD: MEMBER.password,
      },
    },
  );
});

async function signIn(page: Page, email: string, password: string): Promise<void> {
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/w\/[^/]+$/);
}

test('owner manages project access, member sees only their project', async ({ page, browser }) => {
  await signIn(page, OWNER.email, OWNER.password);
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
  await signIn(memberPage, MEMBER.email, MEMBER.password);
  await memberPage.getByRole('link', { name: 'Projects' }).click();
  await expect(memberPage.getByRole('link', { name: 'Alpha' })).toBeVisible();
  await expect(memberPage.getByRole('link', { name: 'Beta' })).toHaveCount(0);
  await expect(memberPage.getByRole('link', { name: 'New project' })).toHaveCount(0);
  await memberContext.close();

  await page.reload();
  await page.getByRole('button', { name: `Remove ${MEMBER.name}` }).click();
  await expect(page.getByRole('row', { name: new RegExp(MEMBER.email) })).toBeVisible();
  await page.getByRole('button', { name: `Confirm remove ${MEMBER.name}` }).click();
  await expect(
    page.getByRole('region', { name: `Access to remove for ${MEMBER.name}` }),
  ).toBeVisible();
  await expect(page.getByRole('row', { name: new RegExp(MEMBER.email) })).toHaveCount(0);
});
