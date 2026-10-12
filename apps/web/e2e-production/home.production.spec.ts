import { expect, test } from '@playwright/test';

// Production browser smoke: `next start` only, no API. JavaScript is blocked so
// this proves the statically rendered homepage message and CTAs work pre-hydration.
// Real-API journeys live in e2e/interactive.spec.ts and stay separate.
test('serves the statically rendered interactive-first landing page from next start', async ({
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
  await expect(page.getByRole('heading', { level: 1, name: 'StoryMe' })).toBeVisible();
  await expect(page.getByText(/interactive illustrated stories/i)).toBeVisible();
  for (const step of ['Choose a path', 'Resume later', 'Reread with illustrations']) {
    await expect(page.getByRole('heading', { level: 2, name: step })).toBeVisible();
  }
  await expect(page.getByText(/gameplay is deterministic/i)).toBeVisible();

  // Anonymous, pre-hydration: the primary CTA and sign-in both keep the destination.
  const primary = page.getByRole('link', { name: 'Start your first story' });
  await expect(primary).toHaveAttribute('href', '/register?next=%2Fdashboard%2Finteractive');
  await expect(page.getByRole('link', { name: 'Sign in', exact: true })).toHaveAttribute(
    'href',
    '/login?next=%2Fdashboard%2Finteractive',
  );

  // Book product stays reachable as clearly labelled secondary links.
  await expect(page.getByRole('link', { name: 'Create a personalized book' })).toHaveAttribute(
    'href',
    '/register',
  );
  await expect(page.getByRole('link', { name: 'View my books' })).toHaveAttribute(
    'href',
    '/dashboard',
  );

  // Production output carries no infrastructure diagnostics.
  await expect(page.getByText(/diagnostics|localhost|\/health/i)).toHaveCount(0);

  // The CTA is usable without JavaScript: following it is a plain navigation.
  await primary.click();
  await expect(page).toHaveURL(/\/register\?next=%2Fdashboard%2Finteractive$/);
});
