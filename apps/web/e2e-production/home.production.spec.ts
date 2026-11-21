import { expect, test } from '@playwright/test';

// Production browser smoke: `next start` only, no API. JavaScript is blocked so
// this proves the statically rendered homepage message and CTAs work pre-hydration.
// Real-API journeys live in e2e/storyme.smoke.spec.ts and stay separate.
test("serves the statically rendered children's-book landing page from next start", async ({
  page,
}) => {
  await page.route('**/*', async (route) => {
    if (route.request().resourceType() === 'script') {
      await route.abort();
      return;
    }
    await route.continue();
  });

  const response = await page.goto('/');

  expect(response?.status()).toBe(200);
  await expect(page).toHaveTitle("StoryMe — Personalized Illustrated Children's Books");
  await expect(page.getByRole('heading', { level: 1, name: 'StoryMe' })).toBeVisible();
  await expect(
    page.getByText('Personalized illustrated storybooks starring your child'),
  ).toBeVisible();
  for (const step of ['Personalize it', 'Get an illustrated story', 'Read and download']) {
    await expect(page.getByRole('heading', { level: 2, name: step })).toBeVisible();
  }
  await expect(page.getByText(/cannot catch everything/i)).toBeVisible();

  // The retired interactive product is not advertised or linked.
  await expect(page.getByText(/interactive|detective|choose your path/i)).toHaveCount(0);
  await expect(page.locator('a[href*="interactive"]')).toHaveCount(0);

  // Anonymous, pre-hydration: the primary CTA and sign-in both keep the destination.
  const primary = page.getByRole('link', { name: 'Create a book', exact: true });
  await expect(primary).toHaveAttribute('href', '/register?next=%2Fdashboard%2Fbooks%2Fnew');
  await expect(page.getByRole('link', { name: 'Sign in', exact: true })).toHaveAttribute(
    'href',
    '/login?next=%2Fdashboard%2Fbooks%2Fnew',
  );

  // The existing library stays one click away.
  await expect(page.getByRole('link', { name: 'Open my library' })).toHaveAttribute(
    'href',
    '/dashboard',
  );

  // Production output carries no infrastructure diagnostics.
  await expect(page.getByText(/diagnostics|localhost|\/health/i)).toHaveCount(0);

  // The CTA is usable without JavaScript: following it is a plain navigation.
  await primary.click();
  await expect(page).toHaveURL(/\/register\?next=%2Fdashboard%2Fbooks%2Fnew$/);
});

test('does not serve the retired interactive routes or artwork from next start', async ({
  page,
}) => {
  for (const path of [
    '/dashboard/interactive',
    '/dashboard/interactive/3f2b1c9a-0000-4000-8000-000000000000',
    '/dashboard/interactive/3f2b1c9a-0000-4000-8000-000000000000/transcript',
    '/interactive/warsaw-noir/v1/s-door.svg',
  ]) {
    const response = await page.request.get(path);
    expect(response.status(), path).toBe(404);
  }
});
