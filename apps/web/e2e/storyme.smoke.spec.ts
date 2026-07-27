import { expect, test } from '@playwright/test';

const loginEmail = 'verified-login@e2e.storyme.test';
const password = 'StoryMeE2E1!';

test('registers a disposable user through the real JWT API', async ({ page }) => {
  const email = `register-${Date.now()}@e2e.storyme.test`;

  await page.goto('/register');
  await page.getByLabel(/^Name/).fill('Disposable E2E User');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Create account' }).click();

  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(page.getByRole('heading', { name: 'My Book Drafts' })).toBeVisible();
  await expect(page.getByText('Please verify your email address')).toBeVisible();
});

test('logs in, generates a mock book, and downloads its PDF', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Email').fill(loginEmail);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();

  await expect(page).toHaveURL(/\/dashboard$/);
  await page.getByRole('link', { name: 'New Book' }).click();
  await page.getByLabel(/Child's name/).fill('Mia');
  await page.getByRole('button', { name: 'Next' }).click();
  await page.getByLabel('Theme').fill('Friendship and courage');
  await page.getByLabel('Number of pages').selectOption('4');
  await page.getByRole('button', { name: 'Next' }).click();
  await page.getByRole('button', { name: 'Create Book' }).click();

  await expect(page).toHaveURL(/\/dashboard\/books\/[0-9a-f-]+$/);
  await page.getByRole('button', { name: 'Generate Story' }).click();
  await expect(page.getByRole('heading', { name: 'Your PDF is ready' })).toBeVisible({
    timeout: 75_000,
  });

  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download PDF' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/\.pdf$/);
  expect((await download.createReadStream())?.readable).toBe(true);
});
