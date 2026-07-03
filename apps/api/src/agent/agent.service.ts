import { Inject, Injectable, Logger } from '@nestjs/common';
import { AgentLogStatus, AgentStep, BookStatus, Prisma, type Book } from '@prisma/client';
import { renderStorybookPdf } from '../pdf/pdf-renderer';
import { PDF_STORAGE_TOKEN, type PdfStorage } from '../pdf/pdf-storage';
import {
  buildImageBufferResolver,
  imageAssetKey,
  IMAGE_ASSET_STORAGE_TOKEN,
  type ImageAssetStorage,
} from '../images/image-asset-storage';
import {
  IMAGE_GENERATION_PROVIDER_TOKEN,
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
const LAYOUT_PAGE_TEMPLATES = [
  'image_top_text_bottom',
  'text_left_image_right',
  'image_left_text_right',
] as const;

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

  // Interior pages — cycle through three templates deterministically
  for (const page of bookPreview.pages) {
    const pageImage = imageResult.images.find(
      (img) => img.kind === 'page' && img.pageNumber === page.pageNumber,
    );
    const template = LAYOUT_PAGE_TEMPLATES[(page.pageNumber - 1) % LAYOUT_PAGE_TEMPLATES.length]!;

    let imageBox: { x: number; y: number; width: number; height: number };
    let textBox: { x: number; y: number; width: number; height: number };

    if (template === 'image_top_text_bottom') {
      imageBox = { x: 180, y: 180, width: 2040, height: 1210 };
      textBox = { x: 180, y: 1420, width: 2040, height: 800 };
    } else if (template === 'text_left_image_right') {
      textBox = { x: 180, y: 180, width: 855, height: 2040 };
      imageBox = { x: 1065, y: 180, width: 1155, height: 2040 };
    } else {
      imageBox = { x: 180, y: 180, width: 1230, height: 2040 };
      textBox = { x: 1440, y: 180, width: 780, height: 2040 };
    }

    entries.push({
      id: `${bookId}-layout-page-${page.pageNumber}`,
      kind: 'page',
      pageNumber: page.pageNumber,
      template,
      trimSize: 'square_8x8',
      canvas: LAYOUT_CANVAS,
      safeArea: LAYOUT_SAFE_AREA,
      bleed: LAYOUT_BLEED,
      ...(pageImage
        ? {
            imageBlock: {
              box: imageBox,
              imageUrl: pageImage.imageUrl,
              altText: pageImage.altText,
              objectFit: 'cover' as const,
            },
          }
        : {}),
      textBlock: {
        box: textBox,
        text: page.text,
        fontFamily: LAYOUT_BODY_FONT,
        fontSize: 18,
        lineHeight: 1.5,
        align: 'left',
        verticalAlign: 'top',
        color: '#1C1917',
      },
      notes: [`Template: ${template}`],
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
   * Generation and saving are two separate failure domains:
   * - A provider.generateImage failure (e.g. a real API outage) rejects this
   *   whole call — the caller treats it like the story-generation failure
   *   path (book marked failed, failedStep: 'image_gen').
   * - A storage save failure for one already-generated image is logged and
   *   skipped — it must not fail book generation; the renderer already falls
   *   back to a placeholder for any entry whose bytes are missing (see
   *   docs/pdf-rendering.md).
   */
  private async generateAndSaveImageAssets(
    bookId: string,
    characterCard: CharacterCard,
    images: GeneratedImageEntry[],
  ): Promise<void> {
    const generated = await Promise.all(
      images.map(async (image) => {
        const { buffer, contentType } = await this.imageGenerationProvider.generateImage({
          bookId,
          entry: image,
          characterCard,
        });
        return { image, buffer, contentType };
      }),
    );

    await Promise.all(
      generated.map(async ({ image, buffer, contentType }) => {
        try {
          const key = imageAssetKey(bookId, image.kind, image.pageNumber);
          await this.imageAssetStorage.saveImageAsset(key, buffer, contentType);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          this.logger.warn(`Failed to save mock image asset for entry "${image.id}": ${message}`);
        }
      }),
    );
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

    const storyDurationMs = Date.now() - startedAt;
    const imageStartedAt = Date.now();

    try {
      await this.generateAndSaveImageAssets(book.id, characterCard, imageGenerationResult.images);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`Image generation failed for book ${book.id}: ${message}`);
      const failed = await this.prisma.book.update({
        where: { id: book.id },
        data: {
          status: BookStatus.failed,
          errorMessage: message,
          failedStep: AgentStep.image_gen,
          generationTimeMs: Date.now() - startedAt,
          aiModelVersions,
        },
      });
      await this.prisma.agentLog.createMany({
        data: [
          {
            bookId: book.id,
            agent: 'LocalPipelineAgent',
            step: AgentStep.image_gen,
            status: AgentLogStatus.error,
            attempt: 1,
            traceId,
            error: message,
            provider: imageProviderName,
            model: imageModelName,
            durationMs: Date.now() - imageStartedAt,
          },
        ],
      });
      return failed;
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
      const buffer = await renderStorybookPdf(bookLayout, { resolveImageBuffer });
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
