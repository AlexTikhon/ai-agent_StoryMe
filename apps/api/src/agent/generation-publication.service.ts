import { Inject, Injectable, Logger } from '@nestjs/common';
import { AgentStep, BookStatus, Prisma, type Book } from '@prisma/client';
import type { QualityReport } from '@book/types';
import { IMAGE_ASSET_STORAGE_TOKEN, type ImageAssetStorage } from '../images/image-asset-storage';
import { PDF_STORAGE_TOKEN, publishedPreviewPdfExists, type PdfStorage } from '../pdf/pdf-storage';
import { bookLayoutStage } from './book-layout.stage';
import type { CharacterBuildStageOutput } from './character-reference.stage';
import {
  type ClaimArtifactNamespace,
  resolvePublishedPdfNamespace,
} from './generation-artifact-namespace';
import type { GenerationExecutionContext } from './generation-execution-context';
import {
  GenerationExecutionService,
  StaleGenerationRunError,
} from './generation-execution.service';
import type { GenerationImagePhaseResult } from './generation-image.service';
import type { GenerationOutcome } from './generation-outcome';
import type { PreparedGenerationContext } from './generation-preparation';
import { GenerationResultCollector } from './generation-result.collector';
import { GenerationResumeService, type ResumeAssetStatus } from './generation-resume.service';
import { imageAssetLabel } from './image-generation.stage';
import { pdfPublicationStage } from './pdf-publication.stage';
import type { StoryGenerationResult } from './story-generation-provider';
import { assertBookLayoutQuality } from './book-layout-quality';

export interface GenerationPublicationInput {
  book: Book;
  ctx: GenerationExecutionContext;
  traceId: string;
  startedAt: number;
  prepared: PreparedGenerationContext;
  story: StoryGenerationResult;
  qualityReport: QualityReport;
  charBuildResult: CharacterBuildStageOutput;
  characterProfileUpdateData: Prisma.BookUpdateInput;
  currentNamespace: ClaimArtifactNamespace;
  imagePhase: GenerationImagePhaseResult;
  priorSheetStatus: ResumeAssetStatus;
  resumable: boolean;
  skippedStoryGeneration: boolean;
  skippedCharacterProfileGeneration: boolean;
  skippedCharacterSheetGeneration: boolean;
  storyDurationMs: number;
  qualityDurationMs: number;
}

/**
 * Owns the deterministic publication tail after image generation. It may
 * persist fenced intermediate layout data, but terminal Book/GenerationRun
 * state remains exclusively owned by GenerationRunCoordinator.
 */
@Injectable()
export class GenerationPublicationService {
  private readonly logger = new Logger(GenerationPublicationService.name);

  constructor(
    private readonly execution: GenerationExecutionService,
    private readonly resume: GenerationResumeService,
    private readonly collector: GenerationResultCollector,
    @Inject(IMAGE_ASSET_STORAGE_TOKEN)
    private readonly imageAssetStorage: ImageAssetStorage,
    @Inject(PDF_STORAGE_TOKEN)
    private readonly pdfStorage: PdfStorage,
  ) {}

  async publish(input: GenerationPublicationInput): Promise<GenerationOutcome> {
    const {
      book,
      ctx,
      prepared,
      story,
      qualityReport,
      charBuildResult,
      characterProfileUpdateData,
      imagePhase,
    } = input;
    const { characterCard, storyPlan, bookPreview } = story;
    const imageGenerationResult = imagePhase.imageGenerationResult;

    await this.execution.markStep(ctx, bookLayoutStage.step);
    const layoutStartedAt = Date.now();
    const bookLayout = bookLayoutStage.execute({
      bookId: book.id,
      bookPreview,
      imageGenerationResult,
    });
    assertBookLayoutQuality(bookLayout, bookPreview.pages.length);
    const layoutDurationMs = Date.now() - layoutStartedAt;

    await this.execution.applyFencedBookWrite(
      ctx,
      {
        status: BookStatus.layout,
        title: storyPlan.title,
        characterCard: characterCard as unknown as Prisma.InputJsonValue,
        storyPlan: storyPlan as unknown as Prisma.InputJsonValue,
        bookPreview: bookPreview as unknown as Prisma.InputJsonValue,
        qualityReport: qualityReport as unknown as Prisma.InputJsonValue,
        imageGenerationResult: imageGenerationResult as unknown as Prisma.InputJsonValue,
        bookLayout: bookLayout as unknown as Prisma.InputJsonValue,
        lastGenerationInputHash: ctx.inputHash,
        lastGenerationRunId: ctx.runId,
        lastGenerationFencingVersion: ctx.fencingVersion,
        ...characterProfileUpdateData,
      },
      bookLayoutStage.step,
    );

    this.assertNotSuperseded(ctx, pdfPublicationStage.step);
    await this.execution.markStep(ctx, pdfPublicationStage.step);

    let previewPdfUrl: string | null = null;
    let pdfRenderError: string | undefined;
    const pdfStartedAt = Date.now();
    try {
      const published = await pdfPublicationStage.execute({
        bookId: book.id,
        bookLayout,
        namespace: input.currentNamespace,
        imageAssetStorage: this.imageAssetStorage,
        pdfStorage: this.pdfStorage,
        logger: this.logger,
      });
      previewPdfUrl = published.previewPdfUrl;
    } catch (error) {
      pdfRenderError = error instanceof Error ? error.message : String(error);
      this.logger.error(`PDF render failed for book ${book.id}: ${pdfRenderError}`);
    }
    const pdfDurationMs = Date.now() - pdfStartedAt;
    const finalStatus = pdfRenderError ? BookStatus.failed : BookStatus.complete;

    const afterSheetStatus: ResumeAssetStatus = !charBuildResult.characterProfile.hasCharacterSheet
      ? 'missing'
      : imagePhase.characterReference && imagePhase.characterReference.buffer.length > 0
        ? 'valid'
        : 'invalid';
    const missingAssetsAfterRetry: string[] = [];
    if (afterSheetStatus !== 'valid') missingAssetsAfterRetry.push('character_sheet');
    if (pdfRenderError) {
      missingAssetsAfterRetry.push('pdf');
      const afterImages = await this.resume.classifyImages(
        book.id,
        imageGenerationResult.images,
        input.currentNamespace,
        null,
      );
      missingAssetsAfterRetry.push(
        ...afterImages.missing.map(imageAssetLabel),
        ...afterImages.invalid.map(imageAssetLabel),
      );
    }

    const publishedNamespaceBefore = resolvePublishedPdfNamespace(book);
    const pdfStatusBefore: ResumeAssetStatus =
      publishedNamespaceBefore.kind === 'not_ready'
        ? 'missing'
        : (await publishedPreviewPdfExists(this.pdfStorage, book.id, publishedNamespaceBefore))
          ? 'valid'
          : 'invalid';

    imageGenerationResult.resume = this.collector.collectResumeDiagnostics({
      resumable: input.resumable,
      images: imageGenerationResult.images,
      priorSheetStatus: input.priorSheetStatus,
      pdfStatusBefore,
      reusableImages: imagePhase.reusableImages,
      missingImagesBefore: imagePhase.missingImagesBefore,
      invalidImagesBefore: imagePhase.invalidImagesBefore,
      generatedImageCount: imagePhase.generatedCount,
      skippedStoryGeneration: input.skippedStoryGeneration,
      skippedCharacterProfileGeneration: input.skippedCharacterProfileGeneration,
      skippedCharacterSheetGeneration: input.skippedCharacterSheetGeneration,
      missingAssetsAfterRetry,
      pdfRenderSucceeded: !pdfRenderError,
      finalBookStatus: finalStatus,
    });

    return this.collector.collectOutcome({
      bookId: book.id,
      traceId: input.traceId,
      generationTimeMs: Date.now() - input.startedAt,
      aiModelVersions: prepared.aiModelVersions,
      imageGenerationResult,
      previewPdfUrl,
      finalStatus,
      ...(pdfRenderError && { pdfRenderError }),
      charBuildResult,
      storyProviderName: prepared.storyProviderName,
      storyModelName: prepared.storyModelName,
      imageProviderName: prepared.imageProviderName,
      imageModelName: prepared.imageModelName,
      storyDurationMs: input.storyDurationMs,
      qualityDurationMs: input.qualityDurationMs,
      imageDurationMs: imagePhase.imageDurationMs,
      layoutDurationMs,
      pdfDurationMs,
      failedImageCount: imagePhase.failedCount,
      attemptedImageCount: imagePhase.attemptedImageCount,
      layoutStep: bookLayoutStage.step,
      pdfStep: pdfPublicationStage.step,
    });
  }

  private assertNotSuperseded(ctx: GenerationExecutionContext, step: AgentStep): void {
    if (ctx.signal?.aborted) throw new StaleGenerationRunError(ctx.runId, step);
  }
}
