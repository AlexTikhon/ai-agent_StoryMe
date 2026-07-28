import { expect, test, type Page } from '@playwright/test';

const loginEmail = 'verified-login@e2e.storyme.test';
const password = 'StoryMeE2E1!';
const retryBookId = '00000000-0000-4000-8000-000000000006';

async function login(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Email').fill(loginEmail);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
}

async function createBook(page: Page, childName: string): Promise<void> {
  await page.getByRole('link', { name: 'New Book' }).click();
  await page.getByLabel(/Child's name/).fill(childName);
  await page.getByRole('button', { name: 'Next' }).click();
  await page.getByLabel('Theme').fill('Friendship and courage');
  await page.getByLabel('Number of pages').selectOption('4');
  await page.getByRole('button', { name: 'Next' }).click();
  await page.getByRole('button', { name: 'Create Book' }).click();
  await expect(page).toHaveURL(/\/dashboard\/books\/[0-9a-f-]+$/);
}

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
  await login(page);
  await createBook(page, 'Mia');
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

test('cancels an active generation and shows the credit refund', async ({ page }) => {
  await login(page);
  await createBook(page, 'Casey');
  await page.getByRole('button', { name: 'Generate Story' }).click();

  const cancelButton = page.getByRole('button', { name: 'Cancel generation' });
  await expect(cancelButton).toBeVisible();
  page.once('dialog', (dialog) => dialog.accept());
  await cancelButton.click();

  await expect(page.getByRole('status')).toHaveText('Generation cancelled. 1 credit refunded.');
  await expect(page.getByRole('button', { name: 'Regenerate book' })).toBeVisible();
  await expect(cancelButton).toBeHidden();
});

test('retries a failed book through the worker and publishes its PDF', async ({ page }) => {
  await login(page);
  await page.goto(`/dashboard/books/${retryBookId}`);

  const retryButton = page.getByRole('button', { name: 'Retry generation' });
  await expect(retryButton).toBeVisible();
  page.once('dialog', (dialog) => dialog.accept());
  await retryButton.click();

  await expect(page.getByRole('heading', { name: 'Your PDF is ready' })).toBeVisible({
    timeout: 75_000,
  });
  await expect(page.getByRole('button', { name: 'Download PDF' })).toBeVisible();
});
