import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test, type Page, type Request } from '@playwright/test';

// Production browser coverage for the public sample book: `next start` only,
// no API. One pass runs with JavaScript disabled (the story and its anchor
// navigation are plain server-rendered HTML); the other runs with JavaScript
// enabled while every API request is blocked, so the root AuthProvider's
// session-restore attempt fails exactly as it would with the API down.

interface Illustration {
  src: string;
  alt: string;
}
interface SampleFixture {
  title: string;
  provenance: string;
  cover: { illustration: Illustration };
  pages: { pageNumber: number; heading: string; text: string; illustration: Illustration }[];
  backCover: { text: string; illustration: Illustration };
  pdf: { href: string; pageCount: number };
}

const WEB_ROOT = resolve(__dirname, '..');
const SAMPLE = JSON.parse(
  readFileSync(resolve(WEB_ROOT, 'src/sample-book/sample-book.json'), 'utf8'),
) as SampleFixture;
const BUNDLED_PDF = readFileSync(resolve(WEB_ROOT, `public${SAMPLE.pdf.href}`));
const API_ORIGIN = 'http://127.0.0.1:4100';

const VIEWPORTS = [
  { name: '320px', width: 320, height: 720 },
  { name: '390px', width: 390, height: 844 },
  { name: 'desktop', width: 1280, height: 900 },
] as const;

const ILLUSTRATIONS = [
  SAMPLE.cover.illustration,
  ...SAMPLE.pages.map((page) => page.illustration),
  SAMPLE.backCover.illustration,
];

function recordApiRequests(page: Page): string[] {
  const urls: string[] = [];
  page.on('request', (request: Request) => {
    if (request.url().startsWith(API_ORIGIN)) urls.push(new URL(request.url()).pathname);
  });
  return urls;
}

async function expectIllustrationLoaded(page: Page, illustration: Illustration) {
  const img = page.getByRole('img', { name: illustration.alt, exact: true });
  await expect(img).toHaveAttribute('src', illustration.src);
  await img.scrollIntoViewIfNeeded();
  await expect
    .poll(() => img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0))
    .toBe(true);
}

async function expectNoHorizontalOverflow(page: Page) {
  const { scrollWidth, innerWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }));
  expect(scrollWidth).toBeLessThanOrEqual(innerWidth);
}

async function expectCompleteStory(page: Page) {
  await expect(page).toHaveTitle(`Sample book: ${SAMPLE.title} | StoryMe`);
  await expect(page.getByRole('heading', { level: 1, name: SAMPLE.title })).toBeVisible();
  await expect(page.getByRole('complementary', { name: 'About this sample' })).toContainText(
    SAMPLE.provenance,
  );
  await expect(page.getByRole('heading', { level: 2, name: 'Cover', exact: true })).toBeVisible();
  for (const story of SAMPLE.pages) {
    await expect(
      page.getByRole('heading', { level: 2, name: `Page ${story.pageNumber}: ${story.heading}` }),
    ).toBeVisible();
    await expect(page.getByText(story.text, { exact: true })).toBeVisible();
  }
  await expect(
    page.getByRole('heading', { level: 2, name: 'Back cover', exact: true }),
  ).toBeVisible();
  await expect(page.getByText(SAMPLE.backCover.text, { exact: true })).toBeVisible();

  await expect(page.locator('main img')).toHaveCount(ILLUSTRATIONS.length);
  for (const illustration of ILLUSTRATIONS) await expectIllustrationLoaded(page, illustration);

  for (const link of await page.getByRole('link', { name: 'Create your own book' }).all()) {
    await expect(link).toHaveAttribute('href', '/register?next=%2Fdashboard%2Fbooks%2Fnew');
  }
  await expect(page.getByRole('link', { name: '← Back to StoryMe home' })).toHaveAttribute(
    'href',
    '/',
  );
}

// Under the global `scroll-behavior: smooth`, Chromium on Linux animates native
// fragment navigation for several hundred milliseconds (Windows headless jumps
// at once), and web fonts that finish loading after the first paint reflow the
// page. An action aimed at a moving target misses, and Playwright's retry
// scrolls (`scrollIntoView` without `behavior`) inherit the smooth behavior and
// never catch up. So before each in-page action, wait until fonts have loaded
// and the scroll position is unchanged between two samples.
async function expectPageAtRest(page: Page) {
  let previousScrollY: number | undefined;
  await expect
    .poll(
      async () => {
        const { fontsLoaded, scrollY } = await page.evaluate(() => ({
          fontsLoaded: document.fonts.status === 'loaded',
          scrollY: window.scrollY,
        }));
        const atRest = fontsLoaded && scrollY === previousScrollY;
        previousScrollY = scrollY;
        return atRest;
      },
      { intervals: [100] },
    )
    .toBe(true);
}

async function expectAnchorNavigation(page: Page) {
  const contents = page.getByRole('navigation', { name: 'Sample book pages' });

  await expectPageAtRest(page);
  await contents.getByRole('link', { name: 'Page 3', exact: true }).click();
  await expect(page).toHaveURL(/#page-3$/);
  await expectPageAtRest(page);
  await expect(page.getByRole('heading', { name: /^Page 3:/ })).toBeInViewport();

  await page
    .getByRole('navigation', { name: 'Page 3 navigation' })
    .getByRole('link', { name: /Next: Page 4/ })
    .click();
  await expect(page).toHaveURL(/#page-4$/);
  await expectPageAtRest(page);
  await expect(page.getByRole('heading', { name: /^Page 4:/ })).toBeInViewport();

  // Keyboard: focus a pager link and activate it with Enter.
  await page
    .getByRole('navigation', { name: 'Page 4 navigation' })
    .getByRole('link', { name: /Previous: Page 3/ })
    .focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/#page-3$/);
  await expectPageAtRest(page);
  await expect(page.getByRole('heading', { name: /^Page 3:/ })).toBeInViewport();

  await contents.getByRole('link', { name: 'Back cover', exact: true }).click();
  await expect(page).toHaveURL(/#back-cover$/);
  await expectPageAtRest(page);
  await expect(
    page.getByRole('heading', { level: 2, name: 'Back cover', exact: true }),
  ).toBeInViewport();

  await page
    .getByRole('navigation', { name: 'Back cover navigation' })
    .getByRole('link', { name: /Back to contents/ })
    .click();
  await expect(page).toHaveURL(/#contents$/);
  await expectPageAtRest(page);
  await expect(contents).toBeInViewport();
}

async function expectPdfDownload(page: Page) {
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('link', { name: 'Download the sample PDF' }).first().click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('juno-and-the-runaway-kite.pdf');
  expect(await download.failure()).toBeNull();

  const bytes = readFileSync(await download.path());
  expect(bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  const raw = bytes.toString('latin1');
  expect(raw.match(/\/Type\s*\/Page(?!s)/g) ?? []).toHaveLength(SAMPLE.pdf.pageCount);
  expect(bytes.equals(BUNDLED_PDF)).toBe(true);
}

async function expectLandingSampleLink(page: Page) {
  const response = await page.goto('/');
  expect(response?.status()).toBe(200);
  await expect(page.getByRole('heading', { level: 2, name: SAMPLE.title })).toBeVisible();
  await expectIllustrationLoaded(page, SAMPLE.cover.illustration);
  // Existing destinations are untouched.
  await expect(page.getByRole('link', { name: 'Create a book', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Open my library' })).toHaveAttribute(
    'href',
    '/dashboard',
  );

  const sampleLink = page.getByRole('link', { name: 'Read a sample book' });
  await expect(sampleLink).toHaveAttribute('href', '/sample-book');
  await expectNoHorizontalOverflow(page);
  await sampleLink.click();
  await expect(page).toHaveURL(/\/sample-book$/);
  await expect(page.getByRole('heading', { level: 1, name: SAMPLE.title })).toBeVisible();
}

test.describe('public sample book without JavaScript', () => {
  test.use({ javaScriptEnabled: false, acceptDownloads: true });

  for (const viewport of VIEWPORTS) {
    test(`landing page sample link works at ${viewport.name}`, async ({ page }) => {
      const apiRequests = recordApiRequests(page);
      await page.setViewportSize(viewport);
      await expectLandingSampleLink(page);
      expect(apiRequests).toEqual([]);
    });

    test(`reads the whole sample, navigates and downloads the PDF at ${viewport.name}`, async ({
      page,
    }) => {
      const apiRequests = recordApiRequests(page);
      await page.setViewportSize(viewport);
      const response = await page.goto('/sample-book');
      expect(response?.status()).toBe(200);

      await expectCompleteStory(page);
      await expectNoHorizontalOverflow(page);
      await expectAnchorNavigation(page);
      await expectPdfDownload(page);
      expect(apiRequests).toEqual([]);
    });
  }
});

test.describe('public sample book with JavaScript while the API is unavailable', () => {
  test.use({ acceptDownloads: true });

  test.beforeEach(async ({ page }) => {
    await page.route(`${API_ORIGIN}/**`, (route) => route.abort('connectionrefused'));
  });

  for (const viewport of VIEWPORTS) {
    test(`landing page sample link works at ${viewport.name}`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await expectLandingSampleLink(page);
    });

    test(`renders the sample instead of an auth or error screen at ${viewport.name}`, async ({
      page,
    }) => {
      const apiRequests = recordApiRequests(page);
      await page.setViewportSize(viewport);
      const response = await page.goto('/sample-book');
      expect(response?.status()).toBe(200);
      await page.waitForLoadState('networkidle');

      await expectCompleteStory(page);
      // Next's route announcer is an empty live region; any alert with content is an error.
      await expect(page.locator('main').getByRole('alert')).toHaveCount(0);
      await expect(page.getByRole('alert').filter({ hasText: /\S/ })).toHaveCount(0);
      await expect(page.getByText(/sign in to continue|something went wrong/i)).toHaveCount(0);
      await expect(page).toHaveURL(/\/sample-book$/);
      await expectNoHorizontalOverflow(page);
      await expectAnchorNavigation(page);
      await expectPdfDownload(page);

      // Only the root AuthProvider's session-restore attempt may reach for the
      // API; the sample itself never asks for books, diagnostics, estimates or
      // protected assets.
      expect(apiRequests.every((path) => path.startsWith('/api/auth/'))).toBe(true);
      expect(
        apiRequests.filter((path) => /books|diagnostic|estimate|asset|pdf/.test(path)),
      ).toEqual([]);
    });
  }
});
