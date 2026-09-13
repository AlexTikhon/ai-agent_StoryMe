import { expect, test } from '@playwright/test';

test('serves the statically rendered landing page from next start', async ({ page }) => {
  await page.route('**/*', async (route) => {
    if (route.request().resourceType() === 'script') {
      await route.abort();
      return;
    }
    await route.continue();
  });

  const response = await page.goto('/');

  expect(response?.status()).toBe(200);
  await expect(page.getByRole('heading', { level: 1, name: 'StoryMe' })).toBeVisible();
  await expect(page.getByText("Personalized AI Children's Books")).toBeVisible();
  await expect(page.getByRole('link', { name: 'Create Your First Book' })).toHaveAttribute(
    'href',
    '/register',
  );
});
