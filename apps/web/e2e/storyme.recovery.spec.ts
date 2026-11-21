import { expect, test, type Page } from '@playwright/test';
import type {
  GenerationDiagnosticsDto,
  GenerationProviderCallMetadata,
  LatestGenerationAttemptDiagnostics,
  PublishedEditionDiagnostics,
  RunProviderUsageProjection,
} from '@book/types';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

/**
 * Closeout step 3: one real failure -> retry -> cancel sequence through the
 * local API, BullMQ worker, and artifact storage. Runs only under
 * playwright.recovery.config.ts, whose API fails the second page-2
 * illustration call once (MOCK_FAILURE_ON_MATCH=2): the first generation is
 * match 1, the regeneration is match 2 (fails), and the retry is match 3.
 */

const apiBaseUrl = 'http://127.0.0.1:4100/api';
const loginEmail = 'verified-login@e2e.storyme.test';
const password = 'StoryMeE2E1!';

const GENERATION_TIMEOUT_MS = 120_000;
const ACTIVE_STATUSES = ['char_build', 'story_draft', 'image_gen', 'layout', 'pdf_render'];

interface E2eBook {
  id: string;
  status: string;
  publishedEdition?: string | null;
  bookPreview?: {
    title: string;
    pages: Array<{ pageNumber: number; text: string }>;
  } | null;
}

/**
 * One generation attempt as diagnostics reports it. `latestAttempt` (and its
 * `latestJob` alias) is projected only from the newest GenerationRun and its
 * own ledger. `publishedEdition` is projected only from the published Book
 * columns and the run its pointer names, so after a failed or cancelled
 * attempt it still describes the earlier publication, with that run's
 * identity and usage.
 */
interface RunEvidence {
  attempt: LatestGenerationAttemptDiagnostics;
  usage: RunProviderUsageProjection;
  calls: GenerationProviderCallMetadata[];
}

/** Everything a reader can observe about one published edition. */
interface Publication {
  edition: string;
  title: string;
  pages: string[];
  pdfSha256: string;
  coverSha256: string;
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
  const body = (await (await responsePromise).json()) as { accessToken: string };
  await expect(page).toHaveURL(/\/dashboard$/);
  return body.accessToken;
}

async function apiGet(page: Page, token: string, path: string) {
  return page.request.get(`${apiBaseUrl}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
}

async function readBook(page: Page, token: string, bookId: string): Promise<E2eBook> {
  const response = await apiGet(page, token, `/books/${bookId}`);
  expect(response.status()).toBe(200);
  return (await response.json()) as E2eBook;
}

async function readDiagnostics(
  page: Page,
  token: string,
  bookId: string,
): Promise<GenerationDiagnosticsDto> {
  const response = await apiGet(page, token, `/books/${bookId}/generation-diagnostics`);
  expect(response.status()).toBe(200);
  return (await response.json()) as GenerationDiagnosticsDto;
}

/** The latest attempt; the legacy `latestJob` alias must name the same run. */
function latestAttempt(diagnostics: GenerationDiagnosticsDto): LatestGenerationAttemptDiagnostics {
  expect(diagnostics.latestAttempt?.runId).toBeTruthy();
  expect(diagnostics.latestJob?.id).toBe(diagnostics.latestAttempt!.runId);
  return diagnostics.latestAttempt!;
}

function publishedEdition(diagnostics: GenerationDiagnosticsDto): PublishedEditionDiagnostics {
  expect(diagnostics.publishedEdition).toBeTruthy();
  return diagnostics.publishedEdition!;
}

/** A recorded per-run ledger that reached only mock providers. */
function recordedMockCalls(usage: RunProviderUsageProjection): GenerationProviderCallMetadata[] {
  expect(usage.availability).toBe('recorded');
  if (usage.availability !== 'recorded') return [];
  expect(typeof usage.usage.actualDispatches).toBe('number');
  // Mock providers only: nothing in any run may reach a paid provider.
  expect(usage.usage.actualPaidCalls).toBe(0);
  expect(usage.usage.calls.every(({ provider }) => provider === 'mock')).toBe(true);
  return usage.usage.calls;
}

/** Persisted run timestamps, and a wall clock derived only from them. */
function expectTerminalTimestamps(
  attempt: LatestGenerationAttemptDiagnostics,
  terminal: 'completedAt' | 'failedAt' | 'cancelledAt',
): void {
  const { startedAt, [terminal]: endedAt } = attempt.timestamps;
  expect(endedAt).toBeTruthy();
  if (startedAt) {
    expect(attempt.runWallClockDurationMs).toBe(Date.parse(endedAt!) - Date.parse(startedAt));
  } else {
    expect(attempt.runWallClockDurationMs).toBeNull();
  }
}

/** The latest attempt's identity and its own provider ledger. */
function latestRunEvidence(diagnostics: GenerationDiagnosticsDto): RunEvidence {
  const attempt = latestAttempt(diagnostics);
  return { attempt, usage: attempt.providerUsage, calls: recordedMockCalls(attempt.providerUsage) };
}

function illustrationCalls(
  calls: GenerationProviderCallMetadata[],
  assetLabel?: string,
): GenerationProviderCallMetadata[] {
  return calls.filter(
    (call) =>
      call.operation === 'illustration' &&
      (assetLabel === undefined || call.assetLabel === assetLabel),
  );
}

/** Bounded poll of the persisted book status through the API. */
async function waitForStatus(page: Page, token: string, bookId: string, status: string) {
  await expect
    .poll(async () => (await readBook(page, token, bookId)).status, {
      timeout: GENERATION_TIMEOUT_MS,
    })
    .toBe(status);
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** A structurally complete PDF file, not just a 200 with some body. */
function expectPdfBytes(bytes: Buffer): void {
  expect(bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  expect(bytes.subarray(-1024).toString('latin1')).toContain('%%EOF');
  expect(bytes.toString('latin1')).toMatch(/\/Type\s*\/Page\b/);
}

/** A PNG with a valid signature and non-empty IHDR dimensions. */
function expectPngBytes(bytes: Buffer): void {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  expect(bytes.subarray(0, 8).equals(signature)).toBe(true);
  expect(bytes.subarray(12, 16).toString('ascii')).toBe('IHDR');
  expect(bytes.readUInt32BE(16)).toBeGreaterThan(0);
  expect(bytes.readUInt32BE(20)).toBeGreaterThan(0);
}

/** Reads the current publication and the bytes of its edition-pinned PDF and cover. */
async function capturePublication(page: Page, token: string, bookId: string): Promise<Publication> {
  const book = await readBook(page, token, bookId);
  expect(book.publishedEdition).toBeTruthy();
  expect(book.bookPreview?.pages.length).toBeGreaterThan(0);
  const edition = encodeURIComponent(book.publishedEdition!);

  const pdf = await apiGet(page, token, `/books/${bookId}/pdf/preview?edition=${edition}`);
  expect(pdf.status()).toBe(200);
  expect(pdf.headers()['content-type']).toContain('application/pdf');
  const pdfBytes = await pdf.body();
  expectPdfBytes(pdfBytes);

  const cover = await apiGet(page, token, `/books/${bookId}/images/cover?edition=${edition}`);
  expect(cover.status()).toBe(200);
  expect(cover.headers()['content-type']).toBe('image/png');
  const coverBytes = await cover.body();
  expectPngBytes(coverBytes);

  return {
    edition: book.publishedEdition!,
    title: book.bookPreview!.title,
    pages: book.bookPreview!.pages.map(({ text }) => text),
    pdfSha256: sha256(pdfBytes),
    coverSha256: sha256(coverBytes),
  };
}

/** The reader shows this publication's title and the browser decoded its cover. */
async function expectReaderShows(page: Page, title: string): Promise<void> {
  const reader = page.getByRole('region', { name: 'Published book reader' });
  await expect(reader.getByText(title)).toBeVisible();
  await reader.scrollIntoViewIfNeeded();
  const cover = reader.getByRole('img', { name: 'Illustration for cover' });
  await expect(cover).toBeVisible();
  await expect
    .poll(() => cover.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0))
    .toBe(true);
}

/** Downloads the PDF through the page's own button and returns the saved bytes. */
async function downloadPdfThroughUi(page: Page): Promise<Buffer> {
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download PDF' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/\.pdf$/);
  const bytes = await readFile(await download.path());
  expectPdfBytes(bytes);
  return bytes;
}

async function changeTheme(page: Page, theme: string): Promise<void> {
  await page.getByRole('button', { name: 'Edit' }).click();
  await page.getByLabel('Theme').fill(theme);
  await page.getByRole('button', { name: 'Save' }).click();
}

function confirmNextDialog(page: Page): void {
  page.once('dialog', (dialog) => void dialog.accept());
}

test('recovers a published book through a real failure, retry, and cancellation', async ({
  page,
}) => {
  let token = '';
  let bookId = '';
  let original: Publication;
  let replacement: Publication;
  // Provider usage of each published edition's source run, as first observed.
  let originalUsage: RunProviderUsageProjection;
  let replacementUsage: RunProviderUsageProjection;
  // Each user action creates a new GenerationRun; distinct ids prove that the
  // evidence read after it belongs to that run and not to an earlier one.
  const runIds: string[] = [];
  // Developer diagnostics are disabled in this build: the page itself must
  // never request them (the test's own API reads are not page requests).
  const pageDiagnosticsRequests: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('/generation-diagnostics')) {
      pageDiagnosticsRequests.push(request.url());
    }
  });

  await test.step('sign in with the synthetic account', async () => {
    token = await login(page);
  });

  await test.step('create and fully generate a book', async () => {
    await page.getByRole('link', { name: 'New Book' }).click();
    await page.getByLabel(/Child's name/).fill('Robin');
    await page.getByRole('button', { name: 'Next', exact: true }).click();
    await page.getByLabel('Theme').fill('Friendship and courage');
    await page.getByLabel('Number of pages').selectOption('4');
    await page.getByRole('button', { name: 'Next', exact: true }).click();
    await page.getByRole('button', { name: 'Create Book' }).click();
    await expect(page).toHaveURL(/\/dashboard\/books\/[0-9a-f-]+$/);
    bookId = new URL(page.url()).pathname.split('/').at(-1)!;

    await page.getByRole('button', { name: 'Generate Story' }).click();
    await expect(page.getByRole('heading', { name: 'Your PDF is ready' })).toBeVisible({
      timeout: GENERATION_TIMEOUT_MS,
    });
    await waitForStatus(page, token, bookId, 'complete');

    const diagnostics = await readDiagnostics(page, token, bookId);
    const { attempt, usage, calls } = latestRunEvidence(diagnostics);
    expect(attempt).toMatchObject({
      kind: 'initial',
      status: 'completed',
      isPublishedSource: true,
    });
    expectTerminalTimestamps(attempt, 'completedAt');
    // Match 1 of the page-2 illustration: counted by the injector, not failed.
    expect(illustrationCalls(calls, 'page_2').map(({ status }) => status)).toEqual(['success']);
    const edition = publishedEdition(diagnostics);
    expect(edition.sourceGenerationRun).toMatchObject({
      availability: 'recorded',
      runId: attempt.runId,
      status: 'completed',
    });
    expect(edition.revisedAfterGeneration).toBe(false);
    expect(edition.baseGenerationUsage).toEqual(usage);
    originalUsage = usage;
    runIds.push(attempt.runId);
  });

  await test.step('capture the published edition, text, PDF, and cover', async () => {
    original = await capturePublication(page, token, bookId);
    expect(publishedEdition(await readDiagnostics(page, token, bookId)).edition).toBe(
      original.edition,
    );
    await expectReaderShows(page, original.title);
  });

  await test.step('change the input and regenerate', async () => {
    await changeTheme(page, 'Sea voyage and courage');
    confirmNextDialog(page);
    await page.getByRole('button', { name: 'Regenerate book' }).click();
    await expect(page.getByText(/new version is being generated/i)).toBeVisible();
    expect(ACTIVE_STATUSES).toContain((await readBook(page, token, bookId)).status);
  });

  await test.step('observe the injected provider failure reach the persisted failed state', async () => {
    await waitForStatus(page, token, bookId, 'failed');
    const diagnostics = await readDiagnostics(page, token, bookId);
    expect(diagnostics.status).toBe('failed');
    const { attempt, calls } = latestRunEvidence(diagnostics);
    expect(attempt).toMatchObject({
      kind: 'regenerate',
      status: 'failed',
      isPublishedSource: false,
      error: { failedStep: 'pdf_render' },
    });
    expectTerminalTimestamps(attempt, 'failedAt');
    // The legacy alias still reports a regeneration as `generate`.
    expect(diagnostics.latestJob).toMatchObject({ type: 'generate', status: 'failed' });
    expect(runIds).not.toContain(attempt.runId);
    runIds.push(attempt.runId);

    // Only the injected page-2 illustration failed, once, at the mock provider;
    // every other illustration in this run succeeded.
    const illustrations = illustrationCalls(calls);
    expect(illustrations.filter(({ status }) => status !== 'success')).toEqual([
      expect.objectContaining({
        assetLabel: 'page_2',
        provider: 'mock',
        status: 'error',
        failureKind: 'provider_error',
      }),
    ]);
    expect(illustrationCalls(calls, 'page_2')).toHaveLength(1);
    expect(illustrations.some(({ status }) => status === 'success')).toBe(true);
    expect(calls.filter(({ status }) => status !== 'success')).toHaveLength(1);

    // PDF assembly then refused to publish an incomplete book.
    for (const message of [attempt.error?.message, diagnostics.latestJob?.errorMessage]) {
      expect(message ?? '').toMatch(/missing generated illustration\(s\) for page 2\./);
    }

    // Edition A is still published, with A's own identity and usage — none
    // of the failed attempt's identity, failure or ledger.
    const edition = publishedEdition(diagnostics);
    expect(edition.edition).toBe(original.edition);
    expect(edition.sourceGenerationRun).toMatchObject({
      availability: 'recorded',
      runId: runIds[0],
      status: 'completed',
    });
    expect(edition.baseGenerationUsage).toEqual(originalUsage);
    expect(edition.baseGenerationUsage).not.toEqual(attempt.providerUsage);
    expect(edition.generationRecord.imageFailures).toEqual([]);
    expect(edition.generationRecord.resume?.finalBookStatus).toBe('complete');
    await expect(page.getByText(/new version could not be generated/i)).toBeVisible({
      timeout: 15_000,
    });
  });

  await test.step('keep the original edition, text, PDF, and cover available', async () => {
    expect(await capturePublication(page, token, bookId)).toEqual(original);
    await expect(
      page.getByRole('heading', { name: 'Published PDF remains available' }),
    ).toBeVisible();
    await expectReaderShows(page, original.title);
    expect(sha256(await downloadPdfThroughUi(page))).toBe(original.pdfSha256);

    await page.reload();
    await expect(page.getByText(/new version could not be generated/i)).toBeVisible();
    await expectReaderShows(page, original.title);
    expect(sha256(await downloadPdfThroughUi(page))).toBe(original.pdfSha256);
    expect(await capturePublication(page, token, bookId)).toEqual(original);
  });

  await test.step('retry through the existing UI', async () => {
    confirmNextDialog(page);
    await page.getByRole('button', { name: 'Retry generation' }).click();
    await expect(page.getByText(/new version is being generated/i)).toBeVisible();
  });

  await test.step('publish a new edition with valid bytes and updated content', async () => {
    await waitForStatus(page, token, bookId, 'complete');
    const diagnostics = await readDiagnostics(page, token, bookId);
    const { attempt, usage, calls } = latestRunEvidence(diagnostics);
    expect(attempt).toMatchObject({
      kind: 'retry',
      status: 'completed',
      retryOfRunId: runIds[1],
      isPublishedSource: true,
    });
    expectTerminalTimestamps(attempt, 'completedAt');
    expect(runIds).not.toContain(attempt.runId);
    runIds.push(attempt.runId);
    // The retry may reuse checkpointed story and illustrations, but the missing
    // page 2 must be produced again (match 3), and nothing in this run failed.
    expect(illustrationCalls(calls, 'page_2')).toEqual([
      expect.objectContaining({ provider: 'mock', status: 'success' }),
    ]);
    expect(calls.filter(({ status }) => status !== 'success')).toEqual([]);
    // Publication provenance advanced to the retry.
    const edition = publishedEdition(diagnostics);
    expect(edition.sourceGenerationRun).toMatchObject({
      availability: 'recorded',
      runId: attempt.runId,
      kind: 'retry',
    });
    expect(edition.baseGenerationUsage).toEqual(usage);
    expect(edition.generationRecord.imageFailures).toEqual([]);
    replacementUsage = usage;

    replacement = await capturePublication(page, token, bookId);
    expect(edition.edition).toBe(replacement.edition);
    expect(replacement.edition).not.toBe(original.edition);
    // Content evidence comes from the changed input, not from PDF metadata.
    expect(replacement.title).not.toBe(original.title);
    expect(replacement.pages).toHaveLength(original.pages.length);
    expect(replacement.pages.every((text) => !original.pages.includes(text))).toBe(true);

    // The replaced edition is refused rather than served.
    const staleEdition = encodeURIComponent(original.edition);
    expect(
      (await apiGet(page, token, `/books/${bookId}/pdf/preview?edition=${staleEdition}`)).status(),
    ).toBe(409);
    expect(
      (await apiGet(page, token, `/books/${bookId}/images/cover?edition=${staleEdition}`)).status(),
    ).toBe(409);

    await expect(page.getByRole('heading', { name: 'Your PDF is ready' })).toBeVisible({
      timeout: 15_000,
    });
    await expectReaderShows(page, replacement.title);
    expect(sha256(await downloadPdfThroughUi(page))).toBe(replacement.pdfSha256);
  });

  await test.step('start another regeneration and cancel it while active', async () => {
    await changeTheme(page, 'Mountain trail and kindness');
    confirmNextDialog(page);
    await page.getByRole('button', { name: 'Regenerate book' }).click();

    const cancelButton = page.getByRole('button', { name: 'Cancel generation' });
    await expect(cancelButton).toBeVisible();
    expect(ACTIVE_STATUSES).toContain((await readBook(page, token, bookId)).status);
    confirmNextDialog(page);
    await cancelButton.click();
    await expect(
      page.getByRole('status').filter({ hasText: 'Generation cancelled.' }),
    ).toBeVisible();
  });

  await test.step('keep the last successful publication after cancellation and reload', async () => {
    await waitForStatus(page, token, bookId, 'cancelled');
    const diagnostics = await readDiagnostics(page, token, bookId);
    const attempt = latestAttempt(diagnostics);
    expect(attempt).toMatchObject({
      kind: 'regenerate',
      status: 'cancelled',
      isPublishedSource: false,
      error: null,
    });
    expectTerminalTimestamps(attempt, 'cancelledAt');
    expect(runIds).not.toContain(attempt.runId);
    // The cancelled run reports only its own ledger, or an explicit
    // unavailable state — never the published edition's usage.
    if (attempt.providerUsage.availability === 'unavailable') {
      expect(['never_claimed', 'ledger_absent']).toContain(attempt.providerUsage.reason);
    } else {
      recordedMockCalls(attempt.providerUsage);
    }
    expect(attempt.providerUsage).not.toEqual(replacementUsage);
    const edition = publishedEdition(diagnostics);
    expect(edition.edition).toBe(replacement.edition);
    expect(edition.sourceGenerationRun).toMatchObject({ runId: runIds[2] });
    expect(edition.baseGenerationUsage).toEqual(replacementUsage);
    expect(await capturePublication(page, token, bookId)).toEqual(replacement);

    await page.reload();
    await expect(page.getByText(/new version was cancelled/i)).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Previous PDF still available' })).toBeVisible();
    await expectReaderShows(page, replacement.title);
    expect(sha256(await downloadPdfThroughUi(page))).toBe(replacement.pdfSha256);
    expect((await readBook(page, token, bookId)).status).toBe('cancelled');
    expect(await capturePublication(page, token, bookId)).toEqual(replacement);
  });

  await test.step('make no diagnostics requests from the page while diagnostics are disabled', async () => {
    // The web server inherits this process's environment. Only a disabled
    // build can prove the absence of requests; an enabled one is recorded,
    // not skipped, so the journey's other evidence still counts.
    if (process.env['NEXT_PUBLIC_ENABLE_DEVELOPER_DIAGNOSTICS'] === 'true') {
      test.info().annotations.push({
        type: 'not verified',
        description: 'developer diagnostics were enabled for this web server',
      });
      return;
    }
    expect(pageDiagnosticsRequests).toEqual([]);
  });
});
