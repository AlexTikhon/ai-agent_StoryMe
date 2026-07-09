import { Inject, Injectable, Logger } from '@nestjs/common';
import { AgentLogStatus, AgentStep, BookStatus, Prisma, type Book } from '@prisma/client';
import { renderStorybookPdf, type ImageBufferResolver } from '../pdf/pdf-renderer';
import { PDF_STORAGE_TOKEN, type PdfStorage } from '../pdf/pdf-storage';
import {
  buildImageBufferResolver,
  imageAssetKey,
  IMAGE_ASSET_STORAGE_TOKEN,
  type ImageAssetStorage,
} from '../images/image-asset-storage';
import {
  IMAGE_GENERATION_PROVIDER_TOKEN,
  resolveMaxGeneratedImagesPerBook,
  type ImageGenerationProvider,
} from '../images/image-generation-provider';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../database/prisma.service';
import type {
  BookLayout,
  BookLayoutEntry,
  BookPreview,
  CharacterCard,
  GeneratedImageEntry,
  ImageGenerationResult,
} from '@book/types';
import {
  STORY_GENERATION_PROVIDER_TOKEN,
  type StoryGenerationProvider,
  type StoryGenerationResult,
} from './story-generation-provider';

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
  ) {}

  /** Safe label for Book.aiModelVersions — never empty, never a secret ('mock' when no real model applies). */
  private modelLabel(provider: {
    readonly providerName?: string;
    readonly modelName?: string;
  }): string {
    return provider.modelName ?? provider.providerName ?? 'unknown';
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
  ): Promise<{ generatedCount: number; failedCount: number; lastError?: string }> {
    const isRealProvider = this.imageGenerationProvider.providerName === 'openai';
    const limit = isRealProvider ? resolveMaxGeneratedImagesPerBook() : images.length;
    const imagesToGenerate = images.slice(0, limit);

    if (imagesToGenerate.length < images.length) {
      this.logger.log(
        `Capping real illustration generation to ${imagesToGenerate.length}/${images.length} images for book ${bookId} (MAX_GENERATED_IMAGES_PER_BOOK); the remaining ${images.length - imagesToGenerate.length} page(s) will have no illustration and PDF rendering will fail unless the cap is raised.`,
      );
    }

    let generatedCount = 0;
    let failedCount = 0;
    let lastError: string | undefined;

    await Promise.all(
      imagesToGenerate.map(async (image) => {
        try {
          const { buffer, contentType } = await this.imageGenerationProvider.generateImage({
            bookId,
            entry: image,
            characterCard,
          });
          const key = imageAssetKey(bookId, image.kind, image.pageNumber);
          await this.imageAssetStorage.saveImageAsset(key, buffer, contentType);
          generatedCount++;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          this.logger.warn(
            `Image generation/save failed for entry "${image.id}" (book ${bookId}): ${message}. Falling back to a placeholder for this entry.`,
          );
          failedCount++;
          lastError = message;
        }
      }),
    );

    return { generatedCount, failedCount, ...(lastError !== undefined && { lastError }) };
  }

  async startBookGeneration(book: Book): Promise<Book> {
    const traceId = randomUUID();
    const startedAt = Date.now();
    const childName = book.childName ?? 'Alex';
    const childAge = book.childAge ?? 6;
    const theme = book.theme ?? 'adventure';
    const language = (book.language as string) ?? 'en';
    const pageCount = book.pageCount ?? undefined;
    const educationalMessage = book.educationalMessage ?? undefined;

    const storyProviderName = this.storyGenerationProvider.providerName ?? null;
    const storyModelName = this.storyGenerationProvider.modelName ?? null;
    const imageProviderName = this.imageGenerationProvider.providerName ?? null;
    const imageModelName = this.imageGenerationProvider.modelName ?? null;
    const aiModelVersions = {
      story: this.modelLabel(this.storyGenerationProvider),
      image: this.modelLabel(this.imageGenerationProvider),
    };

    let characterCard: StoryGenerationResult['characterCard'];
    let storyPlanFinal: StoryGenerationResult['storyPlan'];
    let bookPreview: BookPreview;
    let imageGenerationResult: ImageGenerationResult;

    try {
      const result = await this.storyGenerationProvider.generateStory({
        bookId: book.id,
        childName,
        childAge,
        theme,
        language,
        pageCount,
        educationalMessage,
      });
      characterCard = result.characterCard;
      storyPlanFinal = result.storyPlan;
      bookPreview = result.bookPreview;
      imageGenerationResult = result.imageGenerationResult;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`Story generation failed for book ${book.id}: ${message}`);
      const failed = await this.prisma.book.update({
        where: { id: book.id },
        data: {
          status: BookStatus.failed,
          errorMessage: message,
          failedStep: AgentStep.story_plan,
          generationTimeMs: Date.now() - startedAt,
          aiModelVersions,
        },
      });
      await this.prisma.agentLog.createMany({
        data: [
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
      });
      return failed;
    }

    this.logger.log(
      `Story generated for book ${book.id}: ${bookPreview.pages.length} pages, ${imageGenerationResult.images.length} illustrations planned (cover + pages + back cover).`,
    );

    const storyDurationMs = Date.now() - startedAt;
    const imageStartedAt = Date.now();

    const { generatedCount, failedCount, lastError } = await this.generateAndSaveImageAssets(
      book.id,
      characterCard,
      imageGenerationResult.images,
    );

    this.logger.log(
      `Image generation for book ${book.id}: ${generatedCount} generated, ${failedCount} failed, ${imageGenerationResult.images.length} planned.`,
    );

    imageGenerationResult.imageByteProvider = imageProviderName;
    imageGenerationResult.generatedImageCount = generatedCount;
    imageGenerationResult.failedImageCount = failedCount;
    if (lastError !== undefined) {
      imageGenerationResult.lastImageError = lastError;
    }

    const imageDurationMs = Date.now() - imageStartedAt;
    const layoutStartedAt = Date.now();
    const bookLayout = buildBookLayout(book.id, bookPreview, imageGenerationResult);
    const layoutDurationMs = Date.now() - layoutStartedAt;

    // Phase 1: persist all layout data and advance status to 'layout'
    await this.prisma.book.update({
      where: { id: book.id },
      data: {
        status: BookStatus.layout,
        title: storyPlanFinal.title,
        characterCard: characterCard as unknown as Prisma.InputJsonValue,
        storyPlan: storyPlanFinal as unknown as Prisma.InputJsonValue,
        bookPreview: bookPreview as unknown as Prisma.InputJsonValue,
        imageGenerationResult: imageGenerationResult as unknown as Prisma.InputJsonValue,
        bookLayout: bookLayout as unknown as Prisma.InputJsonValue,
      },
    });

    // Phase 2: render PDF (pdf_render step)
    let previewPdfUrl: string | null = null;
    let pdfRenderLogStatus: AgentLogStatus = AgentLogStatus.success;
    let pdfRenderError: string | undefined;
    const pdfStartedAt = Date.now();

    try {
      const resolveImageBuffer = await buildImageBufferResolver(
        this.imageAssetStorage,
        book.id,
        bookLayout.entries,
      );
      assertAllImagesResolved(this.logger, book.id, bookLayout, resolveImageBuffer);
      this.logger.log(
        `Rendering PDF for book ${book.id}: ${bookLayout.entries.length} pages — ${bookLayout.entries.map((e) => describeEntry(e)).join(', ')}.`,
      );
      const buffer = await renderStorybookPdf(bookLayout, { resolveImageBuffer });
      this.logger.log(`PDF rendered for book ${book.id}: ${buffer.length} bytes.`);
      const saved = await this.pdfStorage.savePreviewPdf(book.id, buffer);
      previewPdfUrl = saved.url;
    } catch (err) {
      pdfRenderLogStatus = AgentLogStatus.error;
      pdfRenderError = err instanceof Error ? err.message : String(err);
      this.logger.error(`PDF render failed for book ${book.id}: ${pdfRenderError}`);
    }
    const pdfDurationMs = Date.now() - pdfStartedAt;

    // Phase 3: advance to 'complete' or 'failed' and persist PDF url/error
    const finalStatus = pdfRenderError ? BookStatus.failed : BookStatus.complete;
    const finalData: Prisma.BookUpdateInput = {
      status: finalStatus,
      generationTimeMs: Date.now() - startedAt,
      aiModelVersions,
    };
    if (previewPdfUrl !== null) {
      finalData.previewPdfUrl = previewPdfUrl;
    }
    if (pdfRenderError) {
      finalData.errorMessage = pdfRenderError;
      finalData.failedStep = AgentStep.pdf_render;
    }

    const updated = await this.prisma.book.update({
      where: { id: book.id },
      data: finalData,
    });

    await this.prisma.agentLog.createMany({
      data: [
        {
          bookId: book.id,
          agent: 'LocalPipelineAgent',
          step: AgentStep.char_build,
          status: AgentLogStatus.success,
          attempt: 1,
          traceId,
          provider: storyProviderName,
          model: storyModelName,
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
          status: AgentLogStatus.success,
          attempt: 1,
          traceId,
          provider: imageProviderName,
          model: imageModelName,
          durationMs: imageDurationMs,
          ...(failedCount > 0 && {
            error: `${failedCount} of ${imageGenerationResult.images.length} image(s) failed to generate; PDF rendering will fail below unless every page's illustration is otherwise available.`,
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
      ],
    });

    return updated;
  }
}
