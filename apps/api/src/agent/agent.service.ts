import { Inject, Injectable, Logger } from '@nestjs/common';
import { AgentLogStatus, AgentStep, BookStatus, Prisma, type Book } from '@prisma/client';
import { renderStorybookPdf, type ImageBufferResolver } from '../pdf/pdf-renderer';
import { PDF_STORAGE_TOKEN, publishedPreviewPdfExists, type PdfStorage } from '../pdf/pdf-storage';
import {
  buildImageBufferResolver,
  claimCharacterSheetAssetKey,
  claimImageAssetKey,
  IMAGE_ASSET_STORAGE_TOKEN,
  type ImageAssetStorage,
} from '../images/image-asset-storage';
import {
  hasImageGenerationFailureDetails,
  IMAGE_GENERATION_PROVIDER_TOKEN,
  resolveMaxGeneratedImagesPerBook,
  type ImageGenerationProvider,
  type ImageReference,
} from '../images/image-generation-provider';
import { createHash, randomUUID } from 'node:crypto';
import { PrismaService } from '../database/prisma.service';
import { CHILD_PHOTO_INTEGRITY_MISMATCH } from '../books/child-photo.constants';
import type {
  BookLayout,
  BookLayoutEntry,
  BookPreview,
  CharacterCard,
  CharacterProfile,
  GeneratedImageEntry,
  GenerationProviderName,
  ImageGenerationFailureDetail,
  ImageGenerationResult,
  ResumeDiagnostics,
} from '@book/types';
import {
  STORY_GENERATION_PROVIDER_TOKEN,
  type StoryGenerationProvider,
  type StoryGenerationResult,
} from './story-generation-provider';
import {
  CHARACTER_PROFILE_PROVIDER_TOKEN,
  MockCharacterProfileProvider,
  type CharacterProfileProvider,
} from './character-profile-provider';
import {
  GenerationExecutionService,
  StaleGenerationRunError,
} from './generation-execution.service';
import type { GenerationExecutionContext } from './generation-execution-context';
import type { GenerationOutcome } from './generation-outcome';
import {
  claimNamespace,
  resolveLastGenerationNamespace,
  resolvePublishedPdfNamespace,
  type ClaimArtifactNamespace,
  type GenerationArtifactNamespace,
} from './generation-artifact-namespace';
import { resolveCharacterSheetArtifact, resolveImageArtifact } from './generation-claim-artifacts';

// ── Layout engine constants ────────────────────────────────────────────────────

const LAYOUT_CANVAS = { width: 2400, height: 2400, unit: 'px' as const };
const LAYOUT_SAFE_AREA = { x: 180, y: 180, width: 2040, height: 2040 };
const LAYOUT_BLEED = 90;
const LAYOUT_DISPLAY_FONT = 'Fraunces';
const LAYOUT_BODY_FONT = 'Plus Jakarta Sans';

/**
 * Every story page uses this single stable template: image on top, story
 * text below, consistent margins/font sizes. Previously pages cycled through
 * three templates (including two narrow side-by-side columns), which meant
 * any page whose image didn't resolve at render time was still squeezed into
 * a narrow text column. One template for every page removes that failure
 * mode entirely.
 */
const PAGE_IMAGE_BOX = { x: 180, y: 180, width: 2040, height: 1210 };
const PAGE_TEXT_BOX = { x: 180, y: 1420, width: 2040, height: 800 };

function buildBookLayout(
  bookId: string,
  bookPreview: BookPreview,
  imageResult: ImageGenerationResult,
): BookLayout {
  const entries: BookLayoutEntry[] = [];

  // Cover — full-bleed image with title overlay
  const coverImage = imageResult.images.find((img) => img.kind === 'cover');
  entries.push({
    id: `${bookId}-layout-cover`,
    kind: 'cover',
    template: 'cover_full_bleed',
    trimSize: 'square_8x8',
    canvas: LAYOUT_CANVAS,
    safeArea: LAYOUT_SAFE_AREA,
    bleed: LAYOUT_BLEED,
    ...(coverImage
      ? {
          imageBlock: {
            box: { x: 0, y: 0, width: 2400, height: 2400 },
            imageUrl: coverImage.imageUrl,
            altText: coverImage.altText,
            objectFit: 'cover' as const,
          },
        }
      : {}),
    textBlock: {
      box: { x: 180, y: 1620, width: 2040, height: 600 },
      text: bookPreview.cover.title,
      fontFamily: LAYOUT_DISPLAY_FONT,
      fontSize: 32,
      lineHeight: 1.2,
      align: 'center',
      verticalAlign: 'bottom',
      color: '#FFFFFF',
    },
    notes: ['Full-bleed cover image; title overlaid at bottom within safe area'],
  });

  // Interior pages — all use the single stable image_top_text_bottom template
  for (const page of bookPreview.pages) {
    const pageImage = imageResult.images.find(
      (img) => img.kind === 'page' && img.pageNumber === page.pageNumber,
    );

    if (!pageImage) {
      // No image available for this page (e.g. a gap in image generation) —
      // use the dedicated text-only template so the full safe area is used
      // for text instead of leaving an empty gap where an image block would
      // have been.
      entries.push({
        id: `${bookId}-layout-page-${page.pageNumber}`,
        kind: 'page',
        pageNumber: page.pageNumber,
        template: 'text_only',
        trimSize: 'square_8x8',
        canvas: LAYOUT_CANVAS,
        safeArea: LAYOUT_SAFE_AREA,
        bleed: LAYOUT_BLEED,
        textBlock: {
          box: { x: 180, y: 180, width: 2040, height: 2040 },
          text: page.text,
          fontFamily: LAYOUT_BODY_FONT,
          fontSize: 20,
          lineHeight: 1.6,
          align: 'left',
          verticalAlign: 'top',
          color: '#1C1917',
        },
        notes: ['Template: text_only (no image available for this page)'],
      });
      continue;
    }

    entries.push({
      id: `${bookId}-layout-page-${page.pageNumber}`,
      kind: 'page',
      pageNumber: page.pageNumber,
      template: 'image_top_text_bottom',
      trimSize: 'square_8x8',
      canvas: LAYOUT_CANVAS,
      safeArea: LAYOUT_SAFE_AREA,
      bleed: LAYOUT_BLEED,
      ...(pageImage
        ? {
            imageBlock: {
              box: PAGE_IMAGE_BOX,
              imageUrl: pageImage.imageUrl,
              altText: pageImage.altText,
              objectFit: 'cover' as const,
            },
          }
        : {}),
      textBlock: {
        box: PAGE_TEXT_BOX,
        text: page.text,
        fontFamily: LAYOUT_BODY_FONT,
        fontSize: 18,
        lineHeight: 1.5,
        align: 'left',
        verticalAlign: 'top',
        color: '#1C1917',
      },
      notes: ['Template: image_top_text_bottom'],
    });
  }

  // Back cover — decorative image with summary text overlay
  const backImage = imageResult.images.find((img) => img.kind === 'back_cover');
  entries.push({
    id: `${bookId}-layout-back-cover`,
    kind: 'back_cover',
    template: 'back_cover_summary',
    trimSize: 'square_8x8',
    canvas: LAYOUT_CANVAS,
    safeArea: LAYOUT_SAFE_AREA,
    bleed: LAYOUT_BLEED,
    ...(backImage
      ? {
          imageBlock: {
            box: { x: 0, y: 0, width: 2400, height: 2400 },
            imageUrl: backImage.imageUrl,
            altText: backImage.altText,
            objectFit: 'cover' as const,
          },
        }
      : {}),
    textBlock: {
      box: { x: 300, y: 600, width: 1800, height: 1200 },
      text: `${bookPreview.backCover.message}\n\n${bookPreview.backCover.educationalSummary}`,
      fontFamily: LAYOUT_BODY_FONT,
      fontSize: 16,
      lineHeight: 1.6,
      align: 'center',
      verticalAlign: 'middle',
      color: '#FFFFFF',
    },
    notes: ['Back cover uses full-bleed image; summary text overlaid at center'],
  });

  return {
    status: 'complete',
    trimSize: 'square_8x8',
    entries,
    metadata: {
      title: bookPreview.title,
      childName: bookPreview.cover.childName,
      totalPages: bookPreview.pages.length,
      generatedAt: '1970-01-01T00:00:00.000Z',
    },
  };
}

/** Human-readable label for a layout entry, used in logs and error messages. */
function describeEntry(entry: BookLayoutEntry): string {
  return entry.kind === 'page' && entry.pageNumber != null
    ? `page ${entry.pageNumber}`
    : entry.kind;
}

/**
 * Guards against ever rendering a placeholder in place of a real illustration.
 *
 * Every layout entry that was planned to have an image (entry.imageBlock is
 * set) must have real, resolvable bytes in ImageAssetStorage before we hand
 * the layout to the PDF renderer. If any are missing — whether because
 * MAX_GENERATED_IMAGES_PER_BOOK capped that entry, the real provider failed
 * for it, or the save to ImageAssetStorage failed — this throws a single
 * clear error naming every affected page instead of silently falling through
 * to the renderer's placeholder-rectangle fallback.
 */
function assertAllImagesResolved(
  logger: Logger,
  bookId: string,
  layout: BookLayout,
  resolveImageBuffer: ImageBufferResolver,
): void {
  const missing: string[] = [];

  for (const entry of layout.entries) {
    if (!entry.imageBlock) continue;
    const label = describeEntry(entry);
    const buffer = resolveImageBuffer(entry.imageBlock, entry);
    if (!buffer) {
      logger.error(
        `Missing generated illustration for ${label} (entry ${entry.id}, book ${bookId}) — no bytes found in image storage.`,
      );
      missing.push(label);
    } else {
      logger.log(
        `Resolved illustration for ${label} (entry ${entry.id}, book ${bookId}): ${entry.imageBlock.imageUrl}, ${buffer.length} bytes.`,
      );
    }
  }

  if (missing.length > 0) {
    throw new Error(
      `Cannot render PDF for book ${bookId}: missing generated illustration(s) for ${missing.join(', ')}. ` +
        'Check the image_gen step logs above for provider/storage errors, or raise MAX_GENERATED_IMAGES_PER_BOOK ' +
        'if the real image provider is capping generation for this book.',
    );
  }
}

/** Stable diagnostics label for one planned image entry: 'cover' | 'page_<n>' | 'back_cover'. */
function imageAssetLabel(entry: GeneratedImageEntry): string {
  return entry.kind === 'page' ? `page_${entry.pageNumber}` : entry.kind;
}

/** Safe provider label for ImageGenerationFailureDetail — never a secret, never a raw response. */
function toGenerationProviderName(raw: string | undefined): GenerationProviderName {
  return raw === 'mock' || raw === 'openai' ? raw : 'unknown';
}

/**
 * True when `book` already carries a full prior generation result (story
 * plan, character card, book preview, and planned image list) produced by
 * the *exact same input* this run is executing — the signature of a retry
 * resuming a book that previously made it past Phase 1 of a run with an
 * unchanged input, as opposed to a brand-new book, or a book whose
 * childName/theme/etc. were edited since that prior result was produced.
 *
 * `book.lastGenerationInputHash` (Phase 2D) records the GenerationRun.
 * inputHash that produced whatever JSON currently sits on the row — compared
 * against `inputHash`, the hash of the run currently executing. A `retry`
 * run's inputHash is copied verbatim from the run it retries, so this is
 * always true for an unmodified retry-after-failure; a `regenerate` (or
 * `initial`) run's inputHash is built fresh from the book's *current* fields
 * at run-creation time, so an edit made before regenerating changes the hash
 * and correctly forces a full regeneration instead of silently reusing stale
 * story/images (see BooksService.createRunAndSchedule and
 * generation-input-snapshot.ts). Gating idempotent resume on this means an
 * ordinary first-time `generate` is byte-identical to before this feature
 * existed.
 */
/**
 * Generation-relevant input resolved once at the top of startBookGeneration
 * from the run's immutable GenerationExecutionContext.inputSnapshot — never
 * from the Book row's live columns, which may have been edited since this
 * run was created (see GenerationExecutionContext's doc comment).
 */
interface ResolvedGenerationInput {
  childName: string;
  childAge: number;
  theme: string;
  language: string;
  pageCount: number | undefined;
  educationalMessage: string | undefined;
  childPhoto?: { assetKey: string; contentType: string; sha256: string; sizeBytes: number };
}

function isResumableBook(book: Book, inputHash: string): boolean {
  return (
    book.lastGenerationInputHash === inputHash &&
    book.storyPlan != null &&
    book.characterCard != null &&
    book.bookPreview != null &&
    book.imageGenerationResult != null
  );
}

@Injectable()
export class AgentService {
  private readonly logger = new Logger(AgentService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(PDF_STORAGE_TOKEN) private readonly pdfStorage: PdfStorage,
    @Inject(IMAGE_ASSET_STORAGE_TOKEN) private readonly imageAssetStorage: ImageAssetStorage,
    @Inject(STORY_GENERATION_PROVIDER_TOKEN)
    private readonly storyGenerationProvider: StoryGenerationProvider,
    @Inject(IMAGE_GENERATION_PROVIDER_TOKEN)
    private readonly imageGenerationProvider: ImageGenerationProvider,
    @Inject(CHARACTER_PROFILE_PROVIDER_TOKEN)
    private readonly characterProfileProvider: CharacterProfileProvider,
    private readonly generationExecutionService: GenerationExecutionService,
  ) {}

  /** Safe fallback profile provider used when the injected (possibly real) CharacterProfileProvider throws — never blocks the pipeline on a flaky vision call. */
  private readonly fallbackCharacterProfileProvider = new MockCharacterProfileProvider();

  /**
   * Loads the uploaded child reference photo's bytes and verifies them
   * against the sha256/sizeBytes recorded in the GenerationInputSnapshot at
   * run-creation time before ever handing them to a vision provider. A
   * mismatch — truncated bytes, a different file at the same key, or any
   * other corruption/replacement — is never silently used: this is the one
   * piece of a run's snapshot that is itself a *reference* into mutable
   * storage rather than an inline value, so verifying it is what actually
   * makes the "immutable input" guarantee (see GenerationInputSnapshot's own
   * doc comment) hold for a photo, not just for the plain fields. Returns
   * `{}` (no photo, no error) when nothing was ever uploaded; `{ photo }` on
   * a verified match; `{ integrityError }` (photo omitted) when bytes were
   * found but failed verification, logged at `error` with the stable
   * CHILD_PHOTO_INTEGRITY_MISMATCH code — distinguishable from the ordinary
   * "no bytes found at all" case, which only ever gets a `warn`. Either way,
   * this never throws: like every other char_build sub-failure, a bad photo
   * degrades to text-only character-profile generation rather than failing
   * the whole book.
   */
  private async loadAndVerifyChildPhoto(
    bookId: string,
    childPhoto: ResolvedGenerationInput['childPhoto'],
  ): Promise<{ photo?: { base64: string; contentType: string }; integrityError?: string }> {
    if (!childPhoto) return {};

    const bytes = await this.imageAssetStorage.getImageAsset(childPhoto.assetKey);
    if (!bytes) {
      this.logger.warn(
        `Book ${bookId} has childPhoto asset "${childPhoto.assetKey}" but no bytes were found in image storage; building character profile without a photo.`,
      );
      return {};
    }

    if (bytes.length !== childPhoto.sizeBytes) {
      const integrityError = `${CHILD_PHOTO_INTEGRITY_MISMATCH}: childPhoto asset "${childPhoto.assetKey}" for book ${bookId} is ${bytes.length} bytes, expected ${childPhoto.sizeBytes} — refusing to use it.`;
      this.logger.error(integrityError);
      return { integrityError };
    }
    const actualSha256 = createHash('sha256').update(bytes).digest('hex');
    if (actualSha256 !== childPhoto.sha256) {
      const integrityError = `${CHILD_PHOTO_INTEGRITY_MISMATCH}: childPhoto asset "${childPhoto.assetKey}" for book ${bookId} has sha256 ${actualSha256}, expected ${childPhoto.sha256} — refusing to use it.`;
      this.logger.error(integrityError);
      return { integrityError };
    }

    return { photo: { base64: bytes.toString('base64'), contentType: childPhoto.contentType } };
  }

  /**
   * Builds the book's CharacterProfile (from name/age/theme and, if
   * uploaded, the child's reference photo) and a character-sheet reference
   * image — the actual work behind the AgentStep.char_build step. Never
   * throws: a profile-provider failure falls back to a locally-built mock
   * profile, and a character-sheet failure just leaves
   * characterProfile.hasCharacterSheet = false, so neither can fail the
   * whole book (matching the per-image failure tolerance elsewhere in this
   * pipeline).
   */
  private async buildCharacterProfileAndSheet(
    bookId: string,
    input: ResolvedGenerationInput,
    currentNamespace: ClaimArtifactNamespace,
  ): Promise<{
    characterProfile: CharacterProfile;
    characterSheetKey?: string;
    providerName: string | null;
    modelName: string | null;
    durationMs: number;
    error?: string;
  }> {
    const startedAt = Date.now();
    const { childName, childAge, theme, language } = input;

    const { photo, integrityError } = await this.loadAndVerifyChildPhoto(bookId, input.childPhoto);

    let providerName = this.characterProfileProvider.providerName ?? null;
    const modelName = this.characterProfileProvider.modelName ?? null;
    let characterProfile: CharacterProfile;
    let error: string | undefined = integrityError;
    try {
      characterProfile = await this.characterProfileProvider.buildProfile({
        bookId,
        childName,
        childAge,
        theme,
        language,
        photo,
      });
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `Character profile provider failed for book ${bookId}: ${error}. Falling back to a generic profile.`,
      );
      characterProfile = await this.fallbackCharacterProfileProvider.buildProfile({
        bookId,
        childName,
        childAge,
        theme,
        language,
        photo,
      });
      providerName = 'mock';
    }

    let characterSheetKey: string | undefined;
    try {
      const { buffer, contentType } = await this.imageGenerationProvider.generateCharacterSheet({
        bookId,
        characterProfile,
      });
      const key = claimCharacterSheetAssetKey(bookId, currentNamespace);
      await this.imageAssetStorage.saveImageAsset(key, buffer, contentType);
      characterSheetKey = key;
      characterProfile = { ...characterProfile, hasCharacterSheet: true };
    } catch (err) {
      const sheetError = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `Character sheet generation/save failed for book ${bookId}: ${sheetError}. Continuing without a character sheet reference image.`,
      );
    }

    return {
      characterProfile,
      ...(characterSheetKey !== undefined && { characterSheetKey }),
      providerName,
      modelName,
      durationMs: Date.now() - startedAt,
      ...(error !== undefined && { error }),
    };
  }

  /** Safe label for Book.aiModelVersions — never empty, never a secret ('mock' when no real model applies). */
  private modelLabel(provider: {
    readonly providerName?: string;
    readonly modelName?: string;
  }): string {
    return provider.modelName ?? provider.providerName ?? 'unknown';
  }

  /**
   * Loads the book's generated character-sheet reference image bytes once
   * (never the original uploaded child photo — that only ever reaches the
   * CharacterProfileProvider's vision step, see buildCharacterProfileAndSheet)
   * so every generateImage call this run can share the same in-memory
   * ImageReference instead of re-reading storage per page.
   *
   * Returns `{}` (no `reference`, no `loadError`) when no character sheet was
   * ever created this run — the ordinary, unremarkable case. Returns
   * `{ loadError }` — logged at `error`, not `warn` — when a character sheet
   * was recorded as existing (a characterSheetKey is set) but its bytes could
   * not be read back from storage; this is distinct from "never had a sheet"
   * and must not be silently indistinguishable from it (see
   * ImageGenerationResult.characterReferenceLoadError). Either way the caller
   * still falls back to text-only generation for this run instead of failing
   * the whole book over a missing consistency aid.
   */
  private async loadCharacterReference(
    bookId: string,
    characterSheetKey: string | undefined,
  ): Promise<{ reference?: ImageReference; loadError?: string }> {
    if (!characterSheetKey) return {};

    const buffer = await this.imageAssetStorage.getImageAsset(characterSheetKey);
    if (!buffer) {
      const loadError = `Character sheet asset "${characterSheetKey}" for book ${bookId} is recorded as existing but its bytes could not be loaded from image storage; continuing with text-only image generation for this run.`;
      this.logger.error(loadError);
      return { loadError };
    }

    // Character sheets are always saved as 'image/png' by both
    // MockImageGenerationProvider.generateCharacterSheet and
    // OpenAIImageGenerationProvider.generateCharacterSheet — ImageAssetStorage
    // itself doesn't track content type on read, so this is a safe, stable
    // assumption rather than a guess.
    return { reference: { buffer, contentType: 'image/png' } };
  }

  /**
   * Generates real image bytes for every generated image entry via the
   * injected ImageGenerationProvider, then saves them via ImageAssetStorage,
   * keyed to match buildImageBufferResolver's lookup (imageAssetKey).
   *
   * Does not throw here: both a provider.generateImage failure (e.g. a real
   * API outage) and an ImageAssetStorage.saveImageAsset failure for one entry
   * are caught, logged, and counted individually so the rest of the batch can
   * keep going. The caller surfaces generatedCount/failedCount/lastError via
   * ImageGenerationResult.generatedImageCount/failedImageCount/lastImageError
   * for diagnostics — but any entry left without saved bytes here causes
   * assertAllImagesResolved to throw before the PDF is rendered (see
   * startBookGeneration's Phase 2), failing the book with a clear error
   * instead of silently rendering a placeholder for it.
   *
   * Before any of that, real (paid) generation is capped to the first
   * MAX_GENERATED_IMAGES_PER_BOOK entries (default 3, see
   * resolveMaxGeneratedImagesPerBook) when the injected provider is the real
   * one — entries beyond the cap never reach the provider at all, so they
   * cost nothing but also have no bytes, which means a book with more planned
   * illustrations than the cap will now fail at the PDF-render step. Raise
   * MAX_GENERATED_IMAGES_PER_BOOK to cover every page for a full real-image
   * test run. The free mock provider is never capped.
   */
  private async generateAndSaveImageAssets(
    bookId: string,
    characterCard: CharacterCard,
    images: GeneratedImageEntry[],
    characterReference: ImageReference | undefined,
    currentNamespace: ClaimArtifactNamespace,
  ): Promise<{
    generatedCount: number;
    failedCount: number;
    lastError?: string;
    usedCharacterReference: boolean;
    failures: ImageGenerationFailureDetail[];
  }> {
    const isRealProvider = this.imageGenerationProvider.providerName === 'openai';
    const limit = isRealProvider ? resolveMaxGeneratedImagesPerBook() : images.length;
    const imagesToGenerate = images.slice(0, limit);

    if (imagesToGenerate.length < images.length) {
      this.logger.log(
        `Capping real illustration generation to ${imagesToGenerate.length}/${images.length} images for book ${bookId} (MAX_GENERATED_IMAGES_PER_BOOK); the remaining ${images.length - imagesToGenerate.length} page(s) will have no illustration and PDF rendering will fail unless the cap is raised.`,
      );
    }

    const providerName = toGenerationProviderName(this.imageGenerationProvider.providerName);
    const modelName = this.imageGenerationProvider.modelName;
    const attemptedRequestMode: ImageGenerationFailureDetail['requestMode'] = characterReference
      ? 'character-reference-edit'
      : 'text-to-image';

    let generatedCount = 0;
    let failedCount = 0;
    let lastError: string | undefined;
    let usedCharacterReference = false;
    const failures: ImageGenerationFailureDetail[] = [];

    await Promise.all(
      imagesToGenerate.map(async (image) => {
        try {
          const { buffer, contentType, usedReference } =
            await this.imageGenerationProvider.generateImage({
              bookId,
              entry: image,
              characterCard,
              ...(characterReference && { characterReference }),
            });
          const key = claimImageAssetKey(bookId, currentNamespace, image.kind, image.pageNumber);
          await this.imageAssetStorage.saveImageAsset(key, buffer, contentType);
          generatedCount++;
          if (usedReference) usedCharacterReference = true;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          this.logger.warn(
            `Image generation/save failed for entry "${image.id}" (book ${bookId}): ${message}. Falling back to a placeholder for this entry.`,
          );
          failedCount++;
          lastError = message;
          const details = hasImageGenerationFailureDetails(err) ? err.details : {};
          failures.push({
            assetLabel: imageAssetLabel(image),
            provider: providerName,
            ...(modelName && { model: modelName }),
            ...(details.httpStatus !== undefined && { httpStatus: details.httpStatus }),
            ...(details.errorType !== undefined && { errorType: details.errorType }),
            ...(details.errorCode !== undefined && { errorCode: details.errorCode }),
            message,
            attempts: details.attempts ?? 1,
            limiterRetries: details.limiterRetries ?? 0,
            limiterWaitMs: details.limiterWaitMs ?? 0,
            characterReferenceSupplied:
              details.characterReferenceSupplied ?? characterReference !== undefined,
            requestMode: details.requestMode ?? attemptedRequestMode,
            ...(details.timeoutMs !== undefined && { timeoutMs: details.timeoutMs }),
            ...(details.elapsedMs !== undefined && { elapsedMs: details.elapsedMs }),
            ...(details.retryDecision !== undefined && { retryDecision: details.retryDecision }),
          });
        }
      }),
    );

    return {
      generatedCount,
      failedCount,
      usedCharacterReference,
      failures,
      ...(lastError !== undefined && { lastError }),
    };
  }

  /**
   * Classifies whether a book's character-sheet reference image is usable,
   * copying it forward from `sourceNamespace` into `currentNamespace` first
   * when the current claim doesn't already have a valid one (Phase B, Slice
   * B3 — see generation-claim-artifacts.ts). `sourceNamespace` must be
   * `null` whenever copy-forward must not be attempted (the run's input
   * changed since the source JSON was produced — see `resumable` at this
   * method's call site): 'missing'/'invalid' if none was ever
   * intended/keyed or is unreadable/empty even after that attempt, 'valid'
   * (with the current-claim key) otherwise.
   */
  private async resolveCharacterSheetForClaim(
    bookId: string,
    profile: CharacterProfile,
    currentNamespace: ClaimArtifactNamespace,
    sourceNamespace: GenerationArtifactNamespace | null,
  ): Promise<{ status: 'valid' | 'missing' | 'invalid'; key?: string }> {
    if (!profile.hasCharacterSheet) return { status: 'missing' };
    const resolution = await resolveCharacterSheetArtifact({
      storage: this.imageAssetStorage,
      bookId,
      currentNamespace,
      sourceNamespace,
    });
    if (resolution.outcome === 'reused' || resolution.outcome === 'copied') {
      return { status: 'valid', key: resolution.key };
    }
    return { status: resolution.sourceStatus === 'invalid' ? 'invalid' : 'missing' };
  }

  /**
   * Splits a book's planned image entries (cover/pages/back_cover) into
   * those with already-valid current-claim bytes or a successfully
   * copied-forward source (reusable as-is, no provider call needed) and
   * those that need a fresh generateImage call — either because no source
   * was ever saved for that entry, a prior save left zero bytes, or no
   * source applies at all (Phase B, Slice B3 — see
   * generation-claim-artifacts.ts). On a brand-new book/claim nothing is
   * saved yet and `sourceNamespace` is `null`, so every entry naturally
   * lands in `toGenerate` — this is also the ordinary fresh-generation path,
   * not just resume.
   */
  private async classifyImageAssets(
    bookId: string,
    images: GeneratedImageEntry[],
    currentNamespace: ClaimArtifactNamespace,
    sourceNamespace: GenerationArtifactNamespace | null,
  ): Promise<{
    reusable: GeneratedImageEntry[];
    toGenerate: GeneratedImageEntry[];
    missing: GeneratedImageEntry[];
    invalid: GeneratedImageEntry[];
  }> {
    const reusable: GeneratedImageEntry[] = [];
    const toGenerate: GeneratedImageEntry[] = [];
    const missing: GeneratedImageEntry[] = [];
    const invalid: GeneratedImageEntry[] = [];

    await Promise.all(
      images.map(async (image) => {
        const resolution = await resolveImageArtifact({
          storage: this.imageAssetStorage,
          bookId,
          currentNamespace,
          sourceNamespace,
          kind: image.kind,
          pageNumber: image.pageNumber,
        });
        if (resolution.outcome === 'reused' || resolution.outcome === 'copied') {
          reusable.push(image);
        } else {
          toGenerate.push(image);
          (resolution.sourceStatus === 'invalid' ? invalid : missing).push(image);
        }
      }),
    );

    return { reusable, toGenerate, missing, invalid };
  }

  /**
   * Regenerates only the character-sheet reference image for a book whose
   * CharacterProfile is being reused as-is (resume path) but whose
   * previously saved sheet bytes are missing or invalid. Mirrors the sheet
   * half of buildCharacterProfileAndSheet above — kept separate so reusing a
   * valid profile never re-runs the (possibly real, billed)
   * CharacterProfileProvider just to regenerate a sheet.
   */
  private async regenerateCharacterSheet(
    bookId: string,
    characterProfile: CharacterProfile,
    currentNamespace: ClaimArtifactNamespace,
  ): Promise<{
    characterProfile: CharacterProfile;
    characterSheetKey?: string;
    durationMs: number;
    error?: string;
  }> {
    const startedAt = Date.now();
    try {
      const { buffer, contentType } = await this.imageGenerationProvider.generateCharacterSheet({
        bookId,
        characterProfile,
      });
      const key = claimCharacterSheetAssetKey(bookId, currentNamespace);
      await this.imageAssetStorage.saveImageAsset(key, buffer, contentType);
      return {
        characterProfile: { ...characterProfile, hasCharacterSheet: true },
        characterSheetKey: key,
        durationMs: Date.now() - startedAt,
      };
    } catch (err) {
      const sheetError = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `Character sheet regeneration/save failed for book ${bookId} during resume: ${sheetError}. Continuing without a character sheet reference image.`,
      );
      return {
        characterProfile: { ...characterProfile, hasCharacterSheet: false },
        durationMs: Date.now() - startedAt,
        error: sheetError,
      };
    }
  }

  /**
   * Throws StaleGenerationRunError if the periodic heartbeat
   * (GenerationQueueProcessor) has already discovered a newer claim owns this
   * run and signaled cancellation via ctx.signal — checked at natural
   * checkpoints before expensive/paid provider or storage work (image
   * generation, PDF render) so a fenced-out attempt stops promptly instead of
   * only discovering it's superseded once its next DB write is rejected.
   * This is a best-effort, same-process optimization on top of — never a
   * replacement for — the DB-level fencing every write already goes through;
   * a run can still do a bounded amount of work between one heartbeat tick
   * and the next.
   */
  private assertNotSuperseded(ctx: GenerationExecutionContext, step: AgentStep): void {
    if (ctx.signal?.aborted) {
      throw new StaleGenerationRunError(ctx.runId, step);
    }
  }

  /**
   * Runs the full generation pipeline for one claimed GenerationRun. Every
   * generation-relevant input field (childName/childAge/theme/language/
   * pageCount/educationalMessage/childPhoto) comes from
   * `ctx.inputSnapshot` — the immutable copy frozen when the run was
   * created — never from the Book row's live columns, which may have been
   * edited since. The Book row is still loaded and read for prior-progress
   * fields (story plan/character card/etc., for idempotent resume) and
   * identity, and every write back to it goes through
   * GenerationExecutionService.applyFencedBookWrite so a newer claim/recovery
   * that has since superseded this attempt can never be overwritten by it
   * (see StaleGenerationRunError, which callers must let propagate).
   *
   * Returns a GenerationOutcome rather than writing Book.status=complete/
   * failed itself — that terminal flip is applied by the caller
   * (GenerationRunCoordinator.completeRun) atomically alongside the
   * GenerationRun terminal transition, so there is no window where Book looks
   * done but GenerationRun/activeRunId disagree (see GenerationOutcome's doc
   * comment).
   */
  async startBookGeneration(ctx: GenerationExecutionContext): Promise<GenerationOutcome> {
    const book = await this.prisma.book.findUniqueOrThrow({ where: { id: ctx.bookId } });
    const traceId = randomUUID();
    const startedAt = Date.now();
    const inputHash = ctx.inputHash;
    const snapshot = ctx.inputSnapshot;
    const childName = snapshot.childName ?? 'Alex';
    const childAge = snapshot.childAge ?? 6;
    const theme = snapshot.theme ?? 'adventure';
    const language = snapshot.language ?? 'en';
    const pageCount = snapshot.pageCount ?? undefined;
    const educationalMessage = snapshot.educationalMessage ?? undefined;
    const resolvedInput: ResolvedGenerationInput = {
      childName,
      childAge,
      theme,
      language,
      pageCount,
      educationalMessage,
      ...(snapshot.childPhoto && {
        childPhoto: {
          assetKey: snapshot.childPhoto.assetKey,
          contentType: snapshot.childPhoto.contentType,
          sha256: snapshot.childPhoto.sha256,
          sizeBytes: snapshot.childPhoto.sizeBytes,
        },
      }),
    };

    const storyProviderName = this.storyGenerationProvider.providerName ?? null;
    const storyModelName = this.storyGenerationProvider.modelName ?? null;
    const imageProviderName = this.imageGenerationProvider.providerName ?? null;
    const imageModelName = this.imageGenerationProvider.modelName ?? null;
    const aiModelVersions = {
      story: this.modelLabel(this.storyGenerationProvider),
      image: this.modelLabel(this.imageGenerationProvider),
    };

    // Phase B, Slice B3: this attempt's own claim namespace — every new
    // character sheet/image this run writes lands here, never derived from
    // Book.activeRunId, a fresh DB read, or any other source (see
    // generation-artifact-namespace.ts's ClaimArtifactNamespace doc
    // comment). Resolved unconditionally, alongside `sourceNamespace`
    // (below), before the resumability check — a malformed partial pointer
    // on `book` must fail loudly regardless of whether this run ends up
    // reusing anything.
    const currentNamespace = claimNamespace(ctx.runId, ctx.fencingVersion);
    // The namespace backing whatever resumable JSON currently sits on
    // `book` — a prior claim of this same run (redelivery), a claim from
    // the run being retried, or `{ kind: 'legacy' }` for a pre-Phase-B row.
    // Only ever consulted as a copy-forward *source* below, gated on
    // `resumable` (see copyForwardSourceNamespace) — never trusted as this
    // run's own ownership.
    const sourceNamespace = resolveLastGenerationNamespace(book);

    // Idempotent resume (see "Idempotent resume" in
    // apps/api/docs/local-generation-pipeline.md): a retry against a book
    // that previously made it past Phase 1 of a run already carries a full
    // story/character/image plan on the row — reuse it instead of paying for
    // story/character-profile generation again. A brand-new book has none of
    // this yet, so `resumable` is false and every branch below falls through
    // to the original from-scratch behavior.
    const resumable = isResumableBook(book, inputHash);
    // Copy-forward must never run when the input changed since the source
    // JSON was produced — bytes at `sourceNamespace` were planned for the
    // *old* story/theme (see resolveImageArtifact's doc comment) — so every
    // entry falls straight through to fresh generation into
    // `currentNamespace` instead of copying anything old forward. A valid
    // *current-claim* artifact is still reused either way (see
    // resolveCharacterSheetForClaim/classifyImageAssets below) — that's
    // same-claim re-entry idempotency, not copy-forward, and is never gated
    // on `resumable`.
    const copyForwardSourceNamespace = resumable ? sourceNamespace : null;
    const priorCharacterProfile = book.characterProfile as unknown as CharacterProfile | null;
    const priorSheet = priorCharacterProfile
      ? await this.resolveCharacterSheetForClaim(
          book.id,
          priorCharacterProfile,
          currentNamespace,
          copyForwardSourceNamespace,
        )
      : ({ status: 'missing' } as const);
    const priorSheetStatus = priorSheet.status;
    const canReuseCharacterProfile = resumable && priorCharacterProfile != null;

    // char_build: build the CharacterProfile (+ character-sheet reference
    // image) before the story itself, so every page/cover/back-cover prompt
    // built below can be seeded with it. Persisted below alongside whichever
    // update comes next (the failure-path update or Phase 1's layout
    // update), rather than as its own extra write.
    let charBuildResult: {
      characterProfile: CharacterProfile;
      characterSheetKey?: string;
      providerName: string | null;
      modelName: string | null;
      durationMs: number;
      error?: string;
    };
    let skippedCharacterProfileGeneration = false;
    let skippedCharacterSheetGeneration = false;

    if (canReuseCharacterProfile) {
      skippedCharacterProfileGeneration = true;
      const profileProviderName = this.characterProfileProvider.providerName ?? null;
      const profileModelName = this.characterProfileProvider.modelName ?? null;
      if (priorSheetStatus === 'valid') {
        skippedCharacterSheetGeneration = priorCharacterProfile!.hasCharacterSheet;
        charBuildResult = {
          characterProfile: priorCharacterProfile!,
          ...(priorSheet.key !== undefined && { characterSheetKey: priorSheet.key }),
          providerName: profileProviderName,
          modelName: profileModelName,
          durationMs: 0,
        };
        this.logger.log(
          `Resuming book ${book.id}: reusing existing character profile${
            skippedCharacterSheetGeneration ? ' and character sheet' : ''
          } — skipping char_build generation.`,
        );
      } else {
        this.logger.warn(
          `Book ${book.id} has a character profile but its saved character-sheet bytes are ${priorSheetStatus} — regenerating only the character sheet, reusing the profile as-is.`,
        );
        const sheetResult = await this.regenerateCharacterSheet(
          book.id,
          priorCharacterProfile!,
          currentNamespace,
        );
        charBuildResult = {
          ...sheetResult,
          providerName: profileProviderName,
          modelName: profileModelName,
        };
      }
    } else {
      charBuildResult = await this.buildCharacterProfileAndSheet(
        book.id,
        resolvedInput,
        currentNamespace,
      );
    }
    const { characterProfile } = charBuildResult;
    const characterProfileUpdateData: Prisma.BookUpdateInput = {
      characterProfile: characterProfile as unknown as Prisma.InputJsonValue,
      ...(charBuildResult.characterSheetKey !== undefined && {
        characterSheetAssetKey: charBuildResult.characterSheetKey,
      }),
    };
    this.logger.log(
      `Character profile built for book ${book.id}: provider=${charBuildResult.providerName ?? 'unknown'} hasReferencePhoto=${characterProfile.hasReferencePhoto} hasCharacterSheet=${characterProfile.hasCharacterSheet}.`,
    );

    let characterCard: StoryGenerationResult['characterCard'];
    let storyPlanFinal: StoryGenerationResult['storyPlan'];
    let bookPreview: BookPreview;
    let imageGenerationResult: ImageGenerationResult;
    let skippedStoryGeneration = false;
    let storyDurationMs: number;

    if (resumable) {
      characterCard = book.characterCard as unknown as StoryGenerationResult['characterCard'];
      storyPlanFinal = book.storyPlan as unknown as StoryGenerationResult['storyPlan'];
      bookPreview = book.bookPreview as unknown as BookPreview;
      imageGenerationResult = book.imageGenerationResult as unknown as ImageGenerationResult;
      skippedStoryGeneration = true;
      storyDurationMs = 0;
      this.logger.log(
        `Resuming book ${book.id}: reusing existing story plan/preview/image plan — skipping story generation.`,
      );
    } else {
      try {
        const result = await this.storyGenerationProvider.generateStory({
          bookId: book.id,
          childName,
          childAge,
          theme,
          language,
          pageCount,
          educationalMessage,
          characterProfile,
        });
        characterCard = result.characterCard;
        storyPlanFinal = result.storyPlan;
        bookPreview = result.bookPreview;
        imageGenerationResult = result.imageGenerationResult;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.error(`Story generation failed for book ${book.id}: ${message}`);
        // Not persisted here — see GenerationOutcome's doc comment. Both the
        // AgentLog rows below and status/errorMessage/failedStep are applied
        // by the caller (GenerationRunCoordinator.completeRun) atomically
        // alongside the GenerationRun terminal transition, so a stale/
        // superseded claim that reaches this catch block still writes zero
        // AgentLog rows; generationTimeMs/aiModelVersions/the char_build
        // progress ride along in the same write.
        return {
          status: BookStatus.failed,
          completedStep: AgentStep.story_plan,
          errorCode: 'GENERATION_FAILED',
          errorMessage: message,
          failedStep: AgentStep.story_plan,
          bookUpdate: {
            generationTimeMs: Date.now() - startedAt,
            aiModelVersions,
            ...characterProfileUpdateData,
          },
          agentLogs: [
            {
              bookId: book.id,
              agent: 'LocalPipelineAgent',
              step: AgentStep.char_build,
              status: charBuildResult.error ? AgentLogStatus.error : AgentLogStatus.success,
              attempt: 1,
              traceId,
              provider: charBuildResult.providerName,
              model: charBuildResult.modelName,
              durationMs: charBuildResult.durationMs,
              ...(charBuildResult.error && { error: charBuildResult.error }),
            },
            {
              bookId: book.id,
              agent: 'LocalPipelineAgent',
              step: AgentStep.story_plan,
              status: AgentLogStatus.error,
              attempt: 1,
              traceId,
              error: message,
              provider: storyProviderName,
              model: storyModelName,
              durationMs: Date.now() - startedAt,
            },
          ],
        };
      }
      storyDurationMs = Date.now() - startedAt;
    }

    this.logger.log(
      skippedStoryGeneration
        ? `Book ${book.id}: reusing ${bookPreview.pages.length} pages, ${imageGenerationResult.images.length} planned illustrations from the prior run.`
        : `Story generated for book ${book.id}: ${bookPreview.pages.length} pages, ${imageGenerationResult.images.length} illustrations planned (cover + pages + back cover).`,
    );

    // A superseded run (heartbeat found a newer claim already owns it) is
    // signaled via ctx.signal — checked here, before the expensive/paid
    // image-generation step, so a fenced-out attempt stops doing real
    // provider/storage work as soon as it's detected, rather than only
    // discovering it much later when its final write is rejected anyway.
    this.assertNotSuperseded(ctx, AgentStep.image_gen);

    const imageStartedAt = Date.now();

    const { reference: characterReference, loadError: characterReferenceLoadError } =
      await this.loadCharacterReference(book.id, charBuildResult.characterSheetKey);
    const characterReferenceAvailable = characterReference !== undefined;

    // Idempotent resume: only call the image provider for entries whose
    // current-claim bytes are missing or invalid and no source copy-forward
    // resolves them either; entries with a valid current-claim asset (or a
    // valid, successfully copy-forwarded source one — see
    // classifyImageAssets/generation-claim-artifacts.ts) are reused
    // untouched. On a fresh book/claim nothing is saved yet and
    // `copyForwardSourceNamespace` is `null` unless resumable, so every
    // entry naturally lands in `imagesNeedingGeneration` on a from-scratch
    // run — this is also the ordinary fresh-generation path, not just
    // resume.
    const {
      reusable: reusableImages,
      toGenerate: imagesNeedingGeneration,
      missing: missingImagesBefore,
      invalid: invalidImagesBefore,
    } = await this.classifyImageAssets(
      book.id,
      imageGenerationResult.images,
      currentNamespace,
      copyForwardSourceNamespace,
    );

    if (reusableImages.length > 0) {
      this.logger.log(
        `Book ${book.id}: reusing ${reusableImages.length} already-generated illustration(s) (${reusableImages
          .map(imageAssetLabel)
          .join(', ')}); generating ${imagesNeedingGeneration.length} remaining.`,
      );
    }

    const priorCharacterReferenceUsedForImages =
      imageGenerationResult.characterReferenceUsedForImages === true;
    const priorImageGenerationMode = imageGenerationResult.imageGenerationMode;
    const priorCharacterReferenceAvailable =
      imageGenerationResult.characterReferenceAvailable === true;

    const { generatedCount, failedCount, lastError, usedCharacterReference, failures } =
      await this.generateAndSaveImageAssets(
        book.id,
        characterCard,
        imagesNeedingGeneration,
        characterReference,
        currentNamespace,
      );

    const rateLimitDiagnostics = this.imageGenerationProvider.getRateLimitDiagnostics?.();
    const rateLimitSummary = rateLimitDiagnostics
      ? ` rateLimit: requestsQueued=${rateLimitDiagnostics.requestsQueued} totalWaitMs=${rateLimitDiagnostics.totalWaitMs} rateLimitHits=${rateLimitDiagnostics.rateLimitHits} retriesUsed=${rateLimitDiagnostics.retriesUsed} retryAfterHonored=${rateLimitDiagnostics.retryAfterHonoredCount}.`
      : '';
    this.logger.log(
      `Image generation for book ${book.id}: ${generatedCount} generated, ${reusableImages.length} reused, ${failedCount} failed, ${imageGenerationResult.images.length} planned, characterReferenceAvailable=${characterReferenceAvailable}, characterReferenceUsedForImages=${usedCharacterReference}.${rateLimitSummary}`,
    );

    // Whether a character-sheet reference was actually supplied to this
    // run's attempted images — used for imageGenerationMode below only when
    // nothing succeeded this run. When at least one image did succeed,
    // `usedCharacterReference` (the provider-confirmed signal) still governs
    // mode, exactly as before — e.g. MockImageGenerationProvider never
    // reports usedReference even when a reference was supplied, and that
    // 'text-to-image' reporting for a provider that doesn't meaningfully
    // support reference-edits must stay unchanged. But when every attempted
    // image failed, there is no provider confirmation to rely on at all — in
    // that case the request that was actually *sent* (edits endpoint with a
    // reference attached) must still be reported truthfully instead of
    // silently falling back to 'text-to-image' just because it failed (see
    // "Diagnose and Fix Failed Resumed Back-Cover Generation").
    const attemptedWithCharacterReference =
      imagesNeedingGeneration.length > 0 &&
      generatedCount === 0 &&
      characterReference !== undefined;

    imageGenerationResult.imageByteProvider = imageProviderName;
    imageGenerationResult.generatedImageCount = reusableImages.length + generatedCount;
    imageGenerationResult.failedImageCount = failedCount;
    imageGenerationResult.characterReferenceAvailable =
      characterReferenceAvailable || priorCharacterReferenceAvailable;
    imageGenerationResult.characterReferenceUsedForImages =
      usedCharacterReference || priorCharacterReferenceUsedForImages;
    imageGenerationResult.imageGenerationMode =
      imagesNeedingGeneration.length > 0
        ? usedCharacterReference || attemptedWithCharacterReference
          ? 'character-reference-edit'
          : 'text-to-image'
        : (priorImageGenerationMode ?? 'text-to-image');
    if (lastError !== undefined) {
      imageGenerationResult.lastImageError = lastError;
    }
    if (characterReferenceLoadError !== undefined) {
      imageGenerationResult.characterReferenceLoadError = characterReferenceLoadError;
    } else {
      delete imageGenerationResult.characterReferenceLoadError;
    }
    imageGenerationResult.imageFailures = failures;

    const imageDurationMs = Date.now() - imageStartedAt;
    const layoutStartedAt = Date.now();
    const bookLayout = buildBookLayout(book.id, bookPreview, imageGenerationResult);
    const layoutDurationMs = Date.now() - layoutStartedAt;

    // Phase 1: persist all layout data and advance status to 'layout'
    await this.generationExecutionService.applyFencedBookWrite(
      ctx,
      {
        status: BookStatus.layout,
        title: storyPlanFinal.title,
        characterCard: characterCard as unknown as Prisma.InputJsonValue,
        storyPlan: storyPlanFinal as unknown as Prisma.InputJsonValue,
        bookPreview: bookPreview as unknown as Prisma.InputJsonValue,
        imageGenerationResult: imageGenerationResult as unknown as Prisma.InputJsonValue,
        bookLayout: bookLayout as unknown as Prisma.InputJsonValue,
        // Records which input produced this JSON — see isResumableBook's doc
        // comment. Written here (not on the earlier failure path, where
        // these fields are never set) since this is the only point at which
        // isResumableBook could ever become true for this hash.
        lastGenerationInputHash: inputHash,
        // Phase B, Slice B3: the exact claim namespace backing the JSON
        // above, persisted in the same fenced transaction as that JSON — see
        // resolveLastGenerationNamespace's doc comment. Never written on the
        // earlier failure path (no complete resumable JSON set exists yet
        // there) or from any other Book write in this file.
        lastGenerationRunId: ctx.runId,
        lastGenerationFencingVersion: ctx.fencingVersion,
        ...characterProfileUpdateData,
      },
      AgentStep.layout,
    );

    // Phase 2: render PDF (pdf_render step) — checked again here for the same
    // reason as before image generation: a superseded attempt must not keep
    // doing storage/render work once it's been signaled.
    this.assertNotSuperseded(ctx, AgentStep.pdf_render);

    let previewPdfUrl: string | null = null;
    let pdfRenderLogStatus: AgentLogStatus = AgentLogStatus.success;
    let pdfRenderError: string | undefined;
    const pdfStartedAt = Date.now();

    try {
      const resolveImageBuffer = await buildImageBufferResolver(
        this.imageAssetStorage,
        book.id,
        bookLayout.entries,
        currentNamespace,
      );
      assertAllImagesResolved(this.logger, book.id, bookLayout, resolveImageBuffer);
      this.logger.log(
        `Rendering PDF for book ${book.id}: ${bookLayout.entries.length} pages — ${bookLayout.entries.map((e) => describeEntry(e)).join(', ')}.`,
      );
      const buffer = await renderStorybookPdf(bookLayout, { resolveImageBuffer });
      this.logger.log(`PDF rendered for book ${book.id}: ${buffer.length} bytes.`);
      // Phase B, Slice B4: every new PDF is written under this attempt's own
      // claim namespace, never the legacy shared key — a successful write
      // here does not itself publish anything (see GenerationRunCoordinator.
      // completeRun, the only publication boundary); a claim whose later DB
      // completion loses the fence leaves this write an unpublished orphan.
      const saved = await this.pdfStorage.saveClaimPreviewPdf(book.id, currentNamespace, buffer);
      previewPdfUrl = saved.url;
    } catch (err) {
      pdfRenderLogStatus = AgentLogStatus.error;
      pdfRenderError = err instanceof Error ? err.message : String(err);
      this.logger.error(`PDF render failed for book ${book.id}: ${pdfRenderError}`);
    }
    const pdfDurationMs = Date.now() - pdfStartedAt;

    // Phase 3: advance to 'complete' or 'failed' and persist PDF url/error
    const finalStatus = pdfRenderError ? BookStatus.failed : BookStatus.complete;

    // Idempotent-resume diagnostics (ResumeDiagnostics, @book/types) — a
    // safe, structured summary of what this run reused vs. actually
    // generated, folded into imageGenerationResult (no schema migration,
    // same pattern Phase 3E used for generatedImageCount/failedImageCount)
    // and surfaced via GET /:id/generation-diagnostics.
    // Reuses the single characterReference already loaded above (via
    // loadCharacterReference) instead of reading ImageAssetStorage again for
    // the same key — some tests assert the character-sheet key is only ever
    // read once per run (see "loads the character-sheet bytes only once" in
    // agent.service.spec.ts).
    const afterSheetStatus: 'valid' | 'missing' | 'invalid' = !characterProfile.hasCharacterSheet
      ? 'missing'
      : characterReference && characterReference.buffer.length > 0
        ? 'valid'
        : 'invalid';
    const missingAssetsAfterRetry: string[] = [];
    if (afterSheetStatus !== 'valid') missingAssetsAfterRetry.push('character_sheet');
    if (pdfRenderError) {
      missingAssetsAfterRetry.push('pdf');
      // Re-checks current-claim state only — no further copy-forward attempt
      // (`sourceNamespace: null`), since the first classifyImageAssets pass
      // above already resolved every reusable/copied entry for this claim.
      const afterImages = await this.classifyImageAssets(
        book.id,
        imageGenerationResult.images,
        currentNamespace,
        null,
      );
      missingAssetsAfterRetry.push(
        ...afterImages.missing.map(imageAssetLabel),
        ...afterImages.invalid.map(imageAssetLabel),
      );
    }

    const requiredAssets = [
      'character_sheet',
      ...imageGenerationResult.images.map(imageAssetLabel),
      'pdf',
    ];
    // Phase B, Slice B4: what was actually *published* for this book before
    // this attempt started — resolved through the same namespace pointer
    // every other production PDF read goes through (see
    // resolvePublishedPdfNamespace), never the legacy key directly. `book`
    // here is the row loaded at the top of this method, so this reflects
    // pre-attempt state regardless of what this claim itself writes below.
    const publishedNamespaceBefore = resolvePublishedPdfNamespace(book);
    const pdfStatusBefore: 'valid' | 'missing' | 'invalid' =
      publishedNamespaceBefore.kind === 'not_ready'
        ? 'missing'
        : (await publishedPreviewPdfExists(this.pdfStorage, book.id, publishedNamespaceBefore))
          ? 'valid'
          : 'invalid';
    const validExistingAssets = [
      ...(priorSheetStatus === 'valid' ? ['character_sheet'] : []),
      ...reusableImages.map(imageAssetLabel),
      ...(pdfStatusBefore === 'valid' ? ['pdf'] : []),
    ];
    const missingAssetsBeforeRetry = [
      ...(priorSheetStatus === 'missing' ? ['character_sheet'] : []),
      ...missingImagesBefore.map(imageAssetLabel),
      ...(pdfStatusBefore === 'missing' ? ['pdf'] : []),
    ];
    const invalidAssetsBeforeRetry = [
      ...(priorSheetStatus === 'invalid' ? ['character_sheet'] : []),
      ...invalidImagesBefore.map(imageAssetLabel),
      ...(pdfStatusBefore === 'invalid' ? ['pdf'] : []),
    ];

    const resumeDiagnostics: ResumeDiagnostics = {
      resumeMode: resumable,
      requiredAssets,
      validExistingAssets,
      missingAssetsBeforeRetry,
      invalidAssetsBeforeRetry,
      reusedImageCount: reusableImages.length,
      regeneratedImageCount: generatedCount,
      skippedStoryGeneration,
      skippedCharacterProfileGeneration,
      skippedCharacterSheetGeneration,
      skippedExistingImageGeneration: reusableImages.length > 0,
      missingAssetsAfterRetry,
      pdfRenderAttempted: true,
      pdfRenderSucceeded: !pdfRenderError,
      finalBookStatus: finalStatus as unknown as ResumeDiagnostics['finalBookStatus'],
    };
    imageGenerationResult.resume = resumeDiagnostics;

    // Not written here — see GenerationOutcome's doc comment. status/
    // errorMessage/failedStep are applied by the caller
    // (GenerationRunCoordinator.completeRun) atomically alongside the
    // GenerationRun terminal transition; everything else below rides along in
    // that same write.
    const finalBookUpdate: Prisma.BookUpdateInput = {
      generationTimeMs: Date.now() - startedAt,
      aiModelVersions,
      imageGenerationResult: imageGenerationResult as unknown as Prisma.InputJsonValue,
    };
    if (previewPdfUrl !== null) {
      finalBookUpdate.previewPdfUrl = previewPdfUrl;
    }

    // Not persisted here — see GenerationOutcome's doc comment. The caller
    // (GenerationRunCoordinator.completeRun) writes these rows atomically
    // inside the same fenced transaction as the terminal Book/GenerationRun
    // write, so a stale/superseded claim that made it all the way through
    // the pipeline still writes zero AgentLog rows if its fencing check then
    // fails.
    const agentLogs: Prisma.AgentLogCreateManyInput[] = [
      {
        bookId: book.id,
        agent: 'LocalPipelineAgent',
        step: AgentStep.char_build,
        status: charBuildResult.error ? AgentLogStatus.error : AgentLogStatus.success,
        attempt: 1,
        traceId,
        provider: charBuildResult.providerName,
        model: charBuildResult.modelName,
        durationMs: charBuildResult.durationMs,
        ...(charBuildResult.error && { error: charBuildResult.error }),
      },
      {
        bookId: book.id,
        agent: 'LocalPipelineAgent',
        step: AgentStep.story_plan,
        status: AgentLogStatus.success,
        attempt: 1,
        traceId,
        provider: storyProviderName,
        model: storyModelName,
        durationMs: storyDurationMs,
      },
      {
        bookId: book.id,
        agent: 'LocalPipelineAgent',
        step: AgentStep.page_plan,
        status: AgentLogStatus.success,
        attempt: 1,
        traceId,
        provider: storyProviderName,
        model: storyModelName,
      },
      {
        bookId: book.id,
        agent: 'LocalPipelineAgent',
        step: AgentStep.story_draft,
        status: AgentLogStatus.success,
        attempt: 1,
        traceId,
        provider: storyProviderName,
        model: storyModelName,
      },
      {
        bookId: book.id,
        agent: 'LocalPipelineAgent',
        step: AgentStep.illust_plan,
        status: AgentLogStatus.success,
        attempt: 1,
        traceId,
        provider: storyProviderName,
        model: storyModelName,
      },
      {
        bookId: book.id,
        agent: 'LocalPipelineAgent',
        step: AgentStep.preview_ready,
        status: AgentLogStatus.success,
        attempt: 1,
        traceId,
        provider: storyProviderName,
        model: storyModelName,
      },
      {
        bookId: book.id,
        agent: 'LocalPipelineAgent',
        step: AgentStep.image_gen,
        // Truthful, not optimistic: a run whose only attempted image(s)
        // failed must not be recorded as 'success' just because the step
        // itself didn't throw (see "Diagnose and Fix Failed Resumed
        // Back-Cover Generation"). AgentLogStatus has no dedicated
        // 'partial' value, so any failedCount > 0 — whether every attempt
        // failed or only some — is recorded as 'error', with the safe
        // summary message below explaining exactly how many succeeded.
        status: failedCount > 0 ? AgentLogStatus.error : AgentLogStatus.success,
        attempt: 1,
        traceId,
        provider: imageProviderName,
        model: imageModelName,
        durationMs: imageDurationMs,
        ...(failedCount > 0 && {
          error: `${failedCount} of ${imagesNeedingGeneration.length} attempted image(s) failed to generate; PDF rendering will fail below unless every page's illustration is otherwise available.`,
        }),
      },
      {
        bookId: book.id,
        agent: 'LocalPipelineAgent',
        step: AgentStep.layout,
        status: AgentLogStatus.success,
        attempt: 1,
        traceId,
        durationMs: layoutDurationMs,
      },
      {
        bookId: book.id,
        agent: 'LocalPipelineAgent',
        step: AgentStep.pdf_render,
        status: pdfRenderLogStatus,
        attempt: 1,
        traceId,
        durationMs: pdfDurationMs,
        ...(pdfRenderError && { error: pdfRenderError }),
      },
    ];

    return {
      status: finalStatus,
      completedStep: AgentStep.pdf_render,
      bookUpdate: finalBookUpdate,
      ...(pdfRenderError && {
        errorCode: 'GENERATION_FAILED',
        errorMessage: pdfRenderError,
        failedStep: AgentStep.pdf_render,
      }),
      agentLogs,
    };
  }
}
