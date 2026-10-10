/**
 * Orchestration for the manual real-generation smoke test, separated from the
 * CLI entry point (smoke-real-generation.ts) so it can be unit tested against
 * mocked ports without booting Nest or touching a provider/storage network.
 *
 * It drives the *supported* generation lifecycle rather than calling
 * AgentService directly: admission through the same service the HTTP endpoint
 * uses (creating the immutable GenerationRun + input snapshot and the outbox
 * event), execution by the generation worker (claim, fencing, cancellation,
 * terminal coordination via GenerationRunCoordinator.completeRun), and then a
 * bounded wait for the persisted run to reach a terminal state. Success is
 * only ever concluded from authoritative persisted records reloaded after
 * that terminal state — never from an intermediate GenerationOutcome.
 */
import type { AgentLog, Book, GenerationRun } from '@prisma/client';
import { buildGenerationDiagnostics } from '../src/books/generation-diagnostics';
import {
  formatDiagnosticsSummary,
  type SmokeBookConfig,
  type SmokeValidationExtras,
} from './smoke-real-generation-helpers';

export type SmokeStage = 'setup' | 'admission' | 'generation' | 'diagnostics' | 'verification';

export type SmokePhotoContentType = 'image/jpeg' | 'image/png' | 'image/webp';

/** A validated reference photo ready to upload. Bytes are only ever handed to the upload port — never logged. */
export interface SmokePhoto {
  buffer: Buffer;
  contentType: SmokePhotoContentType;
}

export interface SmokePersistedState {
  book: Book;
  logs: AgentLog[];
  run: GenerationRun | null;
}

/**
 * Everything the smoke run needs from the outside world. The CLI wires these
 * to the real Nest services; tests wire them to mocks.
 */
export interface SmokePorts {
  ensureUser(): Promise<{ id: string }>;
  /** Makes sure the smoke user can afford one generation (admission debits GENERATION_CREDIT_COST). */
  ensureCredits(userId: string): Promise<void>;
  createBook(userId: string, config: SmokeBookConfig): Promise<{ id: string }>;
  uploadChildPhoto(userId: string, bookId: string, photo: SmokePhoto): Promise<void>;
  /** Admission: creates the GenerationRun + immutable input snapshot and schedules it. Does not execute it. */
  startGeneration(userId: string, bookId: string): Promise<void>;
  getLatestRun(bookId: string): Promise<GenerationRun | null>;
  cancelGeneration(userId: string, bookId: string): Promise<void>;
  /** Authoritative reload of the persisted Book, recent AgentLogs and latest GenerationRun. */
  loadPersisted(userId: string, bookId: string): Promise<SmokePersistedState>;
  /** The published preview PDF, read through the supported (owner-checked, publication-aware) read API. */
  readPublishedPdf(userId: string, bookId: string): Promise<Buffer>;
  /** A published illustration by its public image id (`cover`, `page-N`, `back-cover`). */
  readPublishedImage(userId: string, bookId: string, imageId: string): Promise<Buffer>;
  /** Raw stored asset by the exact key persisted on the Book (character sheet). */
  readStoredAsset(key: string): Promise<Buffer | undefined>;
  dispose(): Promise<void>;
}

export interface SmokeClock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export interface SmokeRunOptions {
  config: SmokeBookConfig;
  /** Present when SMOKE_CHILD_PHOTO_PATH was supplied and validated. */
  photo?: SmokePhoto;
  /** Whether character-profile, story and image providers are all `openai` — the only setup where visual-reference consistency can be verified. */
  visualReferenceExpected: boolean;
  timeoutMs: number;
  pollIntervalMs: number;
  clock: SmokeClock;
  log: (line: string) => void;
}

export type SmokeResult = { ok: true } | { ok: false; stage: SmokeStage; reason: string };

const TERMINAL_RUN_STATUSES = new Set<GenerationRun['status']>([
  'completed',
  'failed',
  'cancelled',
]);

class SmokeFailure extends Error {
  constructor(
    readonly stage: SmokeStage,
    reason: string,
  ) {
    super(reason);
    this.name = 'SmokeFailure';
  }
}

function check(stage: SmokeStage, condition: boolean, message: string): void {
  if (!condition) throw new SmokeFailure(stage, message);
}

/** Short, secret-scrubbed description of an unexpected error — never a raw provider payload. */
export function describeSmokeError(err: unknown): string {
  const raw = err instanceof Error ? `${err.name}: ${err.message}` : 'non-Error value thrown';
  const scrubbed = raw
    .replace(/sk-[A-Za-z0-9_-]+/g, 'sk-***')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer ***');
  return scrubbed.length > 300 ? `${scrubbed.slice(0, 300)}…` : scrubbed;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

interface ParsedImageEntry {
  kind: 'cover' | 'page' | 'back_cover';
  pageNumber?: number;
}

interface ParsedImageResult {
  images: ParsedImageEntry[];
  failedImageCount: number;
  characterReferenceAvailable: boolean;
  characterReferenceUsedForImages: boolean;
  imageGenerationMode: string | undefined;
}

function parseImageGenerationResult(value: unknown): ParsedImageResult | null {
  const record = asRecord(value);
  if (!record) return null;
  const images: ParsedImageEntry[] = [];
  const rawImages = Array.isArray(record['images']) ? record['images'] : [];
  for (const raw of rawImages) {
    const entry = asRecord(raw);
    const kind = entry?.['kind'];
    if (kind !== 'cover' && kind !== 'page' && kind !== 'back_cover') continue;
    const pageNumber = entry?.['pageNumber'];
    images.push({
      kind,
      ...(typeof pageNumber === 'number' && { pageNumber }),
    });
  }
  const mode = record['imageGenerationMode'];
  return {
    images,
    failedImageCount:
      typeof record['failedImageCount'] === 'number' ? record['failedImageCount'] : 0,
    characterReferenceAvailable: record['characterReferenceAvailable'] === true,
    characterReferenceUsedForImages: record['characterReferenceUsedForImages'] === true,
    imageGenerationMode: typeof mode === 'string' ? mode : undefined,
  };
}

/** Maps a generated image entry to the public published-image id the read API expects. */
export function publishedImageIdFor(entry: ParsedImageEntry): string {
  if (entry.kind === 'cover') return 'cover';
  if (entry.kind === 'back_cover') return 'back-cover';
  if (entry.pageNumber === undefined) {
    throw new SmokeFailure('verification', 'a page image entry has no pageNumber');
  }
  return `page-${entry.pageNumber}`;
}

type WaitResult =
  { kind: 'terminal'; run: GenerationRun } | { kind: 'timeout'; last: GenerationRun | null };

async function waitForTerminalRun(
  ports: SmokePorts,
  bookId: string,
  options: SmokeRunOptions,
): Promise<WaitResult> {
  const deadline = options.clock.now() + options.timeoutMs;
  let last: GenerationRun | null = null;
  for (;;) {
    last = await ports.getLatestRun(bookId);
    if (last && TERMINAL_RUN_STATUSES.has(last.status)) return { kind: 'terminal', run: last };
    if (options.clock.now() >= deadline) return { kind: 'timeout', last };
    await options.clock.sleep(options.pollIntervalMs);
  }
}

async function readPublishedPdfSize(
  ports: SmokePorts,
  userId: string,
  bookId: string,
): Promise<number | undefined> {
  try {
    return (await ports.readPublishedPdf(userId, bookId)).length;
  } catch {
    return undefined;
  }
}

/**
 * Runs the whole smoke flow. Never throws for an anticipated failure — every
 * failure (including a timeout, a failed/cancelled run, or a failed check) is
 * returned as a controlled `{ ok: false }` so the CLI can set a non-zero exit
 * code, and `ports.dispose()` always runs. If the run may still be active when
 * this exits abnormally (timeout or an unexpected error while waiting), it is
 * cancelled best-effort so a stuck smoke run stops spending money.
 */
export async function runSmoke(ports: SmokePorts, options: SmokeRunOptions): Promise<SmokeResult> {
  const { config, log } = options;
  let stage: SmokeStage = 'setup';
  let userId: string | undefined;
  let bookId: string | undefined;
  let runMayBeActive = false;

  try {
    log('[1/5] Ensuring smoke-test user and credits...');
    const user = await ports.ensureUser();
    userId = user.id;
    await ports.ensureCredits(userId);

    log(
      `[2/5] Creating a test book (childAge=${config.childAge}, language=${config.language}, theme="${config.theme}", pageCount=${config.pageCount})...`,
    );
    const book = await ports.createBook(userId, config);
    bookId = book.id;
    log(`      Book id: ${bookId}`);

    if (options.photo) {
      log('[3/5] Uploading child reference photo through the supported upload path...');
      await ports.uploadChildPhoto(userId, bookId, options.photo);
      log(`      Photo accepted (${options.photo.buffer.length} bytes).`);
    } else {
      log('[3/5] No SMOKE_CHILD_PHOTO_PATH set — generating without a reference photo.');
    }

    stage = 'admission';
    log('[4/5] Admitting the generation run (costs money once the worker executes it)...');
    await ports.startGeneration(userId, bookId);
    runMayBeActive = true;

    stage = 'generation';
    log(`      Waiting for the generation worker to finish (timeout ${options.timeoutMs}ms)...`);
    const waited = await waitForTerminalRun(ports, bookId, options);
    if (waited.kind === 'timeout') {
      const lastStatus = waited.last?.status ?? 'no run recorded';
      return {
        ok: false,
        stage,
        reason:
          `timed out after ${options.timeoutMs}ms waiting for a terminal run (last observed: ${lastStatus}). ` +
          'The generation worker may not be running or is stuck; the run is being cancelled.',
      };
    }
    runMayBeActive = false;

    // Authoritative reload only after the run is terminal.
    stage = 'diagnostics';
    const persisted = await ports.loadPersisted(userId, bookId);
    const finalBook = persisted.book;
    const run = persisted.run ?? waited.run;
    log(`[5/5] Building diagnostics (run: ${run.status}, book: ${finalBook.status})...`);
    const diagnostics = buildGenerationDiagnostics(finalBook, persisted.logs, run);
    const imageResult = parseImageGenerationResult(finalBook.imageGenerationResult);

    const published = run.status === 'completed' && finalBook.status === 'complete';
    const pdfSizeBytes = published ? await readPublishedPdfSize(ports, userId, bookId) : undefined;
    const characterSheetAssetId = finalBook.characterSheetAssetKey ?? undefined;
    const extras: SmokeValidationExtras = {
      expectedImageCount: imageResult?.images.length ?? 0,
      fallbackImageCount: imageResult?.failedImageCount ?? 0,
      ...(characterSheetAssetId && { characterSheetAssetId }),
      characterProfileProvider:
        persisted.logs.find((entry) => entry.step === 'char_build')?.provider ?? 'unknown',
      pdfExists: pdfSizeBytes !== undefined,
      ...(pdfSizeBytes !== undefined && { pdfSizeBytes }),
    };
    log('\n--- Validation summary ---');
    log(formatDiagnosticsSummary(diagnostics, extras));

    stage = 'generation';
    if (!published) {
      return {
        ok: false,
        stage,
        reason:
          `run did not publish a complete book (run=${run.status}, book=${finalBook.status}, ` +
          `failedStep=${finalBook.failedStep ?? 'n/a'}). See the validation summary above.`,
      };
    }

    stage = 'verification';
    check(
      stage,
      finalBook.publishedRunId === run.id,
      'expected Book.publishedRunId to point at the completed run',
    );
    check(stage, !!finalBook.previewPdfUrl, 'expected previewPdfUrl to be set');
    check(stage, finalBook.storyPlan !== null, 'expected storyPlan to be persisted');
    check(stage, imageResult !== null, 'expected imageGenerationResult to be persisted');
    check(
      stage,
      finalBook.characterProfile !== null,
      'expected a CharacterProfile to be persisted',
    );
    if (options.photo) {
      check(
        stage,
        diagnostics.characterPersonalization.hasReferencePhoto,
        'expected the uploaded child photo to be recorded on the book',
      );
    }

    if (options.photo && options.visualReferenceExpected && imageResult) {
      check(
        stage,
        !!finalBook.characterSheetAssetKey,
        'expected a character-sheet reference image to be generated and stored',
      );
      const sheet = await ports.readStoredAsset(finalBook.characterSheetAssetKey ?? '');
      check(
        stage,
        !!sheet && sheet.length > 0,
        'expected the character-sheet reference image bytes to be readable from storage',
      );
      check(
        stage,
        imageResult.characterReferenceAvailable,
        'expected characterReferenceAvailable to be true when a character sheet was generated',
      );
      check(
        stage,
        imageResult.characterReferenceUsedForImages,
        'expected page image generation to report visual-reference usage (characterReferenceUsedForImages)',
      );
      log(
        `      Visual-reference character consistency verified (imageGenerationMode=${imageResult.imageGenerationMode}).`,
      );
    } else {
      log(
        '      Skipping visual-reference verification (requires a child photo and CHARACTER_PROFILE_PROVIDER/STORY_GENERATION_PROVIDER/IMAGE_GENERATION_PROVIDER all set to "openai").',
      );
    }

    const images = imageResult?.images ?? [];
    check(stage, images.length > 0, 'expected at least one generated image entry');
    for (const entry of images) {
      const imageId = publishedImageIdFor(entry);
      let bytes: Buffer;
      try {
        bytes = await ports.readPublishedImage(userId, bookId, imageId);
      } catch (err) {
        throw new SmokeFailure(
          stage,
          `could not read published image "${imageId}": ${describeSmokeError(err)}`,
        );
      }
      check(stage, bytes.length > 0, `expected published image bytes for "${imageId}"`);
    }
    log(`      ${images.length} published image(s) read back and verified.`);

    check(
      stage,
      pdfSizeBytes !== undefined,
      'expected the published PDF to be readable from storage',
    );
    check(stage, (pdfSizeBytes ?? 0) > 0, 'expected the published PDF to have non-zero size');

    log('\n✔ Real generation smoke test passed — all checks succeeded.');
    return { ok: true };
  } catch (err) {
    if (err instanceof SmokeFailure) return { ok: false, stage: err.stage, reason: err.message };
    return { ok: false, stage, reason: describeSmokeError(err) };
  } finally {
    if (runMayBeActive && userId && bookId) {
      try {
        await ports.cancelGeneration(userId, bookId);
        log('      Cancelled the still-active smoke run to stop further spend.');
      } catch (err) {
        log(
          `      Could not cancel the smoke run (${describeSmokeError(err)}) — check book ${bookId}.`,
        );
      }
    }
    try {
      await ports.dispose();
    } catch (err) {
      log(`      Cleanup failed while closing the application (${describeSmokeError(err)}).`);
    }
  }
}
