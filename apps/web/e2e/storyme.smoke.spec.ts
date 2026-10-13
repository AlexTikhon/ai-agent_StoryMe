import { expect, test, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';

const apiBaseUrl = 'http://127.0.0.1:4100/api';

const loginEmail = 'verified-login@e2e.storyme.test';
const password = 'StoryMeE2E1!';
const retryBookId = '00000000-0000-4000-8000-000000000006';
const publicationCompleteBookId = '00000000-0000-4000-8000-000000000011';
const publicationRunningBookId = '00000000-0000-4000-8000-000000000012';
const publicationFailedBookId = '00000000-0000-4000-8000-000000000013';
const publicationCancelledBookId = '00000000-0000-4000-8000-000000000014';
const initialFailedBookId = '00000000-0000-4000-8000-000000000015';

interface E2eBook {
  id: string;
  status: string;
  title: string | null;
  childProfileId?: string | null;
  childName?: string | null;
  childAge?: number | null;
  previewPdfUrl?: string | null;
  publishedEdition?: string | null;
  bookPreview?: {
    title: string;
    pages: Array<{ pageNumber: number; text: string }>;
  } | null;
}

async function login(page: Page): Promise<string> {
  await page.goto('/login');
  await page.getByLabel('Email').fill(loginEmail);
  await page.getByLabel('Password').fill(password);
  const responsePromise = page.waitForResponse(
    (response) =>
      response.url() === `${apiBaseUrl}/auth/login` && response.request().method() === 'POST',
  );
  await page.getByRole('button', { name: 'Sign in' }).click();
  const response = await responsePromise;
  const body = (await response.json()) as { accessToken: string };
  await expect(page).toHaveURL(/\/dashboard$/);
  return body.accessToken;
}

async function createBook(page: Page, childName: string): Promise<string> {
  await page.getByRole('link', { name: 'New Book' }).click();
  await page.getByLabel(/Child's name/).fill(childName);
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await page.getByLabel('Theme').fill('Friendship and courage');
  await page.getByLabel('Number of pages').selectOption('4');
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await page.getByRole('button', { name: 'Create Book' }).click();
  await expect(page).toHaveURL(/\/dashboard\/books\/[0-9a-f-]+$/);
  return new URL(page.url()).pathname.split('/').at(-1)!;
}

async function apiBook(page: Page, token: string, bookId: string): Promise<E2eBook> {
  const response = await page.request.get(`${apiBaseUrl}/books/${bookId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(response.status()).toBe(200);
  return response.json() as Promise<E2eBook>;
}

async function apiArtifact(
  page: Page,
  token: string,
  path: string,
): Promise<{ status: number; body: Buffer }> {
  const response = await page.request.get(`${apiBaseUrl}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return { status: response.status(), body: await response.body() };
}

function digest(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function pngDimensions(bytes: Buffer): { width: number; height: number } {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  expect(bytes.subarray(0, 8).equals(signature)).toBe(true);
  expect(bytes.subarray(12, 16).toString('ascii')).toBe('IHDR');
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

/** The published cover route must serve a real, decodable image — not just any 2xx. */
async function expectCoverServed(
  page: Page,
  token: string,
  bookId: string,
  edition?: string | null,
): Promise<Buffer> {
  const query = edition ? `?edition=${encodeURIComponent(edition)}` : '';
  const response = await page.request.get(`${apiBaseUrl}/books/${bookId}/images/cover${query}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(response.status()).toBe(200);
  expect(response.headers()['content-type']).toBe('image/png');
  const body = await response.body();
  expect(body.length).toBeGreaterThan(0);
  const { width, height } = pngDimensions(body);
  expect(width).toBeGreaterThan(0);
  expect(height).toBeGreaterThan(0);
  return body;
}

/** The browser must actually decode the cover illustration, not just show the reader frame. */
async function expectReaderCoverLoaded(page: Page): Promise<void> {
  const reader = page.getByRole('region', { name: 'Published book reader' });
  // The illustration is `loading="lazy"` and has no height until it loads, so a
  // reader far below the fold on a long page never starts loading by itself.
  await reader.scrollIntoViewIfNeeded();
  const cover = reader.getByRole('img', { name: 'Illustration for cover' });
  await expect(cover).toBeVisible();
  await expect
    .poll(() => cover.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0))
    .toBe(true);
}

async function coverStatus(
  page: Page,
  bookId: string,
  token?: string,
  query = '',
): Promise<number> {
  const response = await page.request.get(`${apiBaseUrl}/books/${bookId}/images/cover${query}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  return response.status();
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

test('persists a JWT session across refresh, logs out, and protects the dashboard', async ({
  page,
}) => {
  await login(page);
  await page.reload();
  await expect(page.getByText(`Signed in as ${loginEmail}`)).toBeVisible();
  await page.getByRole('button', { name: 'Log out' }).click();
  await expect(page).toHaveURL(/\/login$/);
  await page.goto('/dashboard');
  await expect(page).toHaveURL(/\/login\?next=%2Fdashboard$/);
});

test('manages a saved child profile and snapshots it into a one-off draft without provider calls', async ({
  page,
}) => {
  const token = await login(page);
  const profileName = `Mia ${Date.now()}`;
  await page.getByRole('link', { name: 'Child profiles' }).click();
  await page.getByLabel("Child's name").fill(profileName);
  await page.getByLabel('Age').fill('7');
  const createProfileResponse = page.waitForResponse(
    (response) =>
      response.url() === `${apiBaseUrl}/child-profiles` && response.request().method() === 'POST',
  );
  await page.getByRole('button', { name: 'Add profile' }).click();
  const profile = (await (await createProfileResponse).json()) as { id: string };

  await page.getByRole('link', { name: 'My Book Drafts' }).click();
  await page.getByRole('link', { name: 'New Book' }).click();
  await page.getByLabel('Saved child profile').selectOption(profile.id);
  await expect(page.getByLabel(/Child's name/)).toHaveValue(profileName);
  await expect(page.getByRole('spinbutton')).toHaveValue('7');
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await page.getByLabel('Theme').fill('Friendship and courage');
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await page.getByRole('button', { name: 'Create Book' }).click();
  await expect(page).toHaveURL(/\/dashboard\/books\/[0-9a-f-]+$/);
  const bookId = new URL(page.url()).pathname.split('/').at(-1)!;

  const book = await apiBook(page, token, bookId);
  expect(book).toMatchObject({
    childProfileId: profile.id,
    childName: profileName,
    childAge: 7,
  });

  await page.request.patch(`${apiBaseUrl}/child-profiles/${profile.id}`, {
    headers: { Authorization: `Bearer ${token}` },
    data: { name: `${profileName} edited`, age: 8 },
  });
  expect(await apiBook(page, token, bookId)).toMatchObject({
    childName: profileName,
    childAge: 7,
  });
  await page.request.delete(`${apiBaseUrl}/child-profiles/${profile.id}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(await apiBook(page, token, bookId)).toMatchObject({
    childProfileId: profile.id,
    childName: profileName,
    childAge: 7,
  });
  await page.request.delete(`${apiBaseUrl}/books/${bookId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
});

test('logs in, generates a mock book, and downloads its PDF', async ({ page }) => {
  const token = await login(page);
  const bookId = await createBook(page, 'Mia');
  await page.getByRole('button', { name: /view provider-work estimate/i }).click();
  await expect(page.getByText(/estimated provider work: 9 calls/i)).toBeVisible();
  await expect(page.getByText(/estimated external cost: \$0\.00/i)).toBeVisible();
  await page.getByRole('button', { name: 'Generate Story' }).click();
  await expect(page.getByRole('heading', { name: 'Your PDF is ready' })).toBeVisible({
    timeout: 75_000,
  });
  await expectReaderCoverLoaded(page);
  await expectCoverServed(page, token, bookId);

  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download PDF' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/\.pdf$/);
  expect((await download.createReadStream())?.readable).toBe(true);
});

test('cancels an active family generation without requiring a credit charge', async ({ page }) => {
  await login(page);
  await createBook(page, 'Casey');
  await page.getByRole('button', { name: 'Generate Story' }).click();

  const cancelButton = page.getByRole('button', { name: 'Cancel generation' });
  await expect(cancelButton).toBeVisible();
  page.once('dialog', (dialog) => dialog.accept());
  await cancelButton.click();

  await expect(page.getByRole('status')).toHaveText(
    'Generation cancelled. No credit charge was found to refund.',
  );
  await expect(page.getByRole('button', { name: 'Regenerate book' })).toBeVisible();
  await expect(cancelButton).toBeHidden();
});

test('corrects page text and explicitly confirms one page-image regeneration', async ({ page }) => {
  await login(page);
  await createBook(page, 'Taylor');
  await page.getByRole('button', { name: 'Generate Story' }).click();
  await expect(page.getByRole('heading', { name: 'Your PDF is ready' })).toBeVisible({
    timeout: 75_000,
  });

  await page.getByRole('button', { name: 'Next page' }).click();
  await page.getByRole('button', { name: 'Edit page text' }).click();
  await page.getByLabel('Page text').fill('A corrected synthetic page for the family edition.');
  await page.getByRole('button', { name: 'Save page' }).click();
  await expect(
    page
      .getByRole('region', { name: 'Published book reader' })
      .getByText('A corrected synthetic page for the family edition.'),
  ).toBeVisible();

  await page.reload();
  await page.getByRole('button', { name: 'Next page' }).click();
  await expect(
    page
      .getByRole('region', { name: 'Published book reader' })
      .getByText('A corrected synthetic page for the family edition.'),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Regenerate illustration' }).click();
  await expect(page.getByText('Confirm illustration regeneration')).toBeVisible();
  await expect(page.getByText(/no credit purchase is needed in family mode/i)).toBeVisible();
  await page.getByRole('button', { name: 'Confirm regeneration' }).click();
  await expect(page.getByText('The new illustration and PDF are published.')).toBeVisible({
    timeout: 75_000,
  });
  await expect(
    page
      .getByRole('region', { name: 'Published book reader' })
      .getByText('A corrected synthetic page for the family edition.'),
  ).toBeVisible();
});

test.describe('published version availability', () => {
  test('renders a complete publication', async ({ page }) => {
    const token = await login(page);
    await page.goto(`/dashboard/books/${publicationCompleteBookId}`);
    await expect(page.getByRole('region', { name: 'Published book reader' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Your PDF is ready' })).toBeVisible();
    await expectReaderCoverLoaded(page);
    await expectCoverServed(page, token, publicationCompleteBookId);
  });

  test('keeps a publication readable during a running regeneration', async ({ page }) => {
    const token = await login(page);
    await page.goto(`/dashboard/books/${publicationRunningBookId}`);
    await expect(page.getByRole('region', { name: 'Published book reader' })).toBeVisible();
    await expect(page.getByText(/new version is being generated/i)).toBeVisible();
    await expectReaderCoverLoaded(page);
    await expectCoverServed(page, token, publicationRunningBookId);
  });

  test('keeps a publication readable after a failed regeneration', async ({ page }) => {
    const token = await login(page);
    await page.goto(`/dashboard/books/${publicationFailedBookId}`);
    await expect(page.getByRole('region', { name: 'Published book reader' })).toBeVisible();
    await expect(page.getByText(/new version could not be generated/i)).toBeVisible();
    await expectReaderCoverLoaded(page);
    await expectCoverServed(page, token, publicationFailedBookId);
  });

  test('keeps a publication readable after a cancelled regeneration', async ({ page }) => {
    const token = await login(page);
    await page.goto(`/dashboard/books/${publicationCancelledBookId}`);
    await expect(page.getByRole('region', { name: 'Published book reader' })).toBeVisible();
    await expect(page.getByText(/new version was cancelled/i)).toBeVisible();
    await expectReaderCoverLoaded(page);
    await expectCoverServed(page, token, publicationCancelledBookId);
  });

  test('refuses cover reads for anonymous, other-user and stale-edition requests', async ({
    page,
  }) => {
    const token = await login(page);
    const book = await apiBook(page, token, publicationCompleteBookId);
    expect(book.publishedEdition).toBeTruthy();

    // Current edition succeeds; a stale one is refused with the existing 409.
    await expectCoverServed(page, token, publicationCompleteBookId, book.publishedEdition);
    const stale = await page.request.get(
      `${apiBaseUrl}/books/${publicationCompleteBookId}/images/cover?edition=stale-edition`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    expect(stale.status()).toBe(409);
    expect(await stale.json()).toMatchObject({ message: 'PUBLISHED_EDITION_CHANGED' });

    // No credentials: unauthenticated.
    expect(await coverStatus(page, publicationCompleteBookId)).toBe(401);

    // A different verified-or-not user sees the same 404 as a missing book.
    const registered = await page.request.post(`${apiBaseUrl}/auth/register`, {
      data: {
        email: `cover-other-${Date.now()}@e2e.storyme.test`,
        password,
        name: 'Other Cover User',
      },
    });
    expect(registered.status()).toBe(201);
    const { accessToken: otherToken } = (await registered.json()) as { accessToken: string };
    expect(await coverStatus(page, publicationCompleteBookId, otherToken)).toBe(404);
  });

  test('does not invent a publication after a failed initial generation', async ({ page }) => {
    await login(page);
    await page.goto(`/dashboard/books/${initialFailedBookId}`);
    await expect(page.getByText(/generation failed/i)).toBeVisible();
    await expect(page.getByRole('region', { name: 'Published book reader' })).toHaveCount(0);
  });
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

test('atomically replaces a successful publication after complete-book regeneration', async ({
  page,
}) => {
  const token = await login(page);
  const bookId = await createBook(page, 'Morgan');
  await page.getByRole('button', { name: 'Generate Story' }).click();
  await expect(page.getByRole('heading', { name: 'Your PDF is ready' })).toBeVisible({
    timeout: 75_000,
  });

  const oldPublication = await apiBook(page, token, bookId);
  expect(oldPublication.status).toBe('complete');
  expect(oldPublication.bookPreview).toBeTruthy();
  const oldTitle = oldPublication.bookPreview!.title;
  const oldPages = oldPublication.bookPreview!.pages.map(({ text }) => text);
  const oldPdf = await apiArtifact(page, token, `/books/${bookId}/pdf/preview`);
  expect(oldPdf.status).toBe(200);

  await page.getByRole('button', { name: 'Edit' }).click();
  await page.getByLabel('Theme').fill('Sea voyage and courage');
  await page.getByRole('button', { name: 'Save' }).click();
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: 'Regenerate book' }).click();

  await expect(page.getByText(/new version is being generated/i)).toBeVisible();
  await expect(
    page.getByRole('region', { name: 'Published book reader' }).getByText(oldTitle),
  ).toBeVisible();
  const duringRegeneration = await apiBook(page, token, bookId);
  expect(['char_build', 'story_draft', 'image_gen', 'layout', 'pdf_render']).toContain(
    duringRegeneration.status,
  );
  expect(duringRegeneration.bookPreview?.title).toBe(oldTitle);
  expect(duringRegeneration.bookPreview?.pages.map(({ text }) => text)).toEqual(oldPages);
  // The previous publication's cover stays served while a new run is active.
  await expectCoverServed(page, token, bookId, oldPublication.publishedEdition);

  await expect
    .poll(async () => (await apiBook(page, token, bookId)).status, { timeout: 75_000 })
    .toBe('complete');
  const newPublication = await apiBook(page, token, bookId);
  expect(newPublication.bookPreview).toBeTruthy();
  expect(newPublication.bookPreview!.title).not.toBe(oldTitle);
  const newPages = newPublication.bookPreview!.pages.map(({ text }) => text);
  expect(newPages).toHaveLength(oldPages.length);
  expect(newPages.every((text) => !oldPages.includes(text))).toBe(true);

  const newPdf = await apiArtifact(page, token, `/books/${bookId}/pdf/preview`);
  expect(newPdf.status).toBe(200);
  expect(digest(newPdf.body)).not.toBe(digest(oldPdf.body));

  // The new edition serves its own cover; the replaced edition is refused, not served.
  expect(newPublication.publishedEdition).toBeTruthy();
  expect(newPublication.publishedEdition).not.toBe(oldPublication.publishedEdition);
  await expectCoverServed(page, token, bookId, newPublication.publishedEdition);
  expect(
    await coverStatus(page, bookId, token, `?edition=${oldPublication.publishedEdition}`),
  ).toBe(409);

  await expect(
    page
      .getByRole('region', { name: 'Published book reader' })
      .getByText(newPublication.bookPreview!.title),
  ).toBeVisible({ timeout: 15_000 });
  await page.reload();
  await expect(
    page
      .getByRole('region', { name: 'Published book reader' })
      .getByText(newPublication.bookPreview!.title),
  ).toBeVisible();
  await expect(
    page.getByRole('region', { name: 'Published book reader' }).getByText(oldTitle),
  ).toHaveCount(0);
});

test('permanently deletes a synthetic published book and denies every captured artifact route', async ({
  page,
}) => {
  const token = await login(page);
  const bookId = await createBook(page, 'Delete Fixture');
  await page.getByRole('button', { name: 'Generate Story' }).click();
  await expect(page.getByRole('heading', { name: 'Your PDF is ready' })).toBeVisible({
    timeout: 75_000,
  });

  const pdfPath = `/books/${bookId}/pdf/preview`;
  const imagePath = `/books/${bookId}/images/page-1`;
  const coverPath = `/books/${bookId}/images/cover`;
  expect((await apiArtifact(page, token, pdfPath)).status).toBe(200);
  expect((await apiArtifact(page, token, imagePath)).status).toBe(200);
  expect((await apiArtifact(page, token, coverPath)).status).toBe(200);

  page.once('dialog', (dialog) => {
    expect(dialog.message()).toMatch(/permanently delete.*cannot be undone/i);
    return dialog.accept();
  });
  await page.getByRole('button', { name: 'Delete' }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(page.locator(`a[href="/dashboard/books/${bookId}"]`)).toHaveCount(0);

  await expect
    .poll(
      async () =>
        (
          await page.request.get(`${apiBaseUrl}/books/${bookId}`, {
            headers: { Authorization: `Bearer ${token}` },
          })
        ).status(),
      { timeout: 30_000 },
    )
    .toBe(404);
  expect((await apiArtifact(page, token, pdfPath)).status).toBe(404);
  expect((await apiArtifact(page, token, imagePath)).status).toBe(404);
  expect((await apiArtifact(page, token, coverPath)).status).toBe(404);

  await page.goto(`/dashboard/books/${bookId}`);
  await expect(page.getByText('Book not found')).toBeVisible();
  await page.goto('/dashboard');
  await page.reload();
  await expect(page.locator(`a[href="/dashboard/books/${bookId}"]`)).toHaveCount(0);
});
