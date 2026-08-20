import { Inject, Injectable, Logger } from '@nestjs/common';
import { AgentStep, BookStatus, Prisma } from '@prisma/client';
import { PDF_STORAGE_TOKEN, publishedPreviewPdfExists, type PdfStorage } from '../pdf/pdf-storage';
import { IMAGE_ASSET_STORAGE_TOKEN, type ImageAssetStorage } from '../images/image-asset-storage';
import {
  IMAGE_GENERATION_PROVIDER_TOKEN,
  type ImageGenerationProvider,
} from '../images/image-generation-provider';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../database/prisma.service';
import {
  STORY_GENERATION_PROVIDER_TOKEN,
  type StoryGenerationProvider,
} from './story-generation-provider';
import {
  CHARACTER_PROFILE_PROVIDER_TOKEN,
  type CharacterProfileProvider,
} from './character-profile-provider';
import {
  GenerationExecutionService,
  StaleGenerationRunError,
} from './generation-execution.service';
import type { GenerationExecutionContext } from './generation-execution-context';
import type { GenerationOutcome } from './generation-outcome';
import { resolvePublishedPdfNamespace } from './generation-artifact-namespace';
import { bookLayoutStage } from './book-layout.stage';
import { pdfPublicationStage } from './pdf-publication.stage';
import {
  CharacterReferenceStage,
  type CharacterBuildStageOutput,
} from './character-reference.stage';
import { ImageGenerationStage, imageAssetLabel } from './image-generation.stage';
import { GenerationResumeService } from './generation-resume.service';
import { GenerationResultCollector } from './generation-result.collector';
import { prepareGeneration } from './generation-preparation';
import { StoryQualityService } from './story-quality.service';
import { GenerationImageService } from './generation-image.service';

/**
 * Generation-relevant input resolved once at the top of startBookGeneration
 * from the run's immutable GenerationExecutionContext.inputSnapshot — never
 * from the Book row's live columns, which may have been edited since this
 * run was created (see GenerationExecutionContext's doc comment).
 */
@Injectable()
export class AgentService {
  private readonly logger = new Logger(AgentService.name);
  private readonly storyQualityService: StoryQualityService;
  private readonly characterReferenceStage: CharacterReferenceStage;
  private readonly generationImageService: GenerationImageService;
  private readonly generationResumeService: GenerationResumeService;
  private readonly generationResultCollector = new GenerationResultCollector();

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
  ) {
    this.storyQualityService = new StoryQualityService(storyGenerationProvider);
    this.characterReferenceStage = new CharacterReferenceStage(
      imageAssetStorage,
      characterProfileProvider,
      imageGenerationProvider,
    );
    this.generationResumeService = new GenerationResumeService(imageAssetStorage);
    this.generationImageService = new GenerationImageService(
      this.characterReferenceStage,
      new ImageGenerationStage(imageAssetStorage, imageGenerationProvider),
      this.generationResumeService,
      this.generationResultCollector,
      imageGenerationProvider,
    );
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
    const prepared = prepareGeneration(ctx, {
      story: this.storyGenerationProvider,
      image: this.imageGenerationProvider,
      character: this.characterProfileProvider,
    });
    const {
      input: resolvedInput,
      targetPageCount,
      storyRepairEnabled,
      providerTelemetry,
      storyProviderName,
      storyModelName,
      imageProviderName,
      imageModelName,
      aiModelVersions,
    } = prepared;
    const { childName, childAge, theme, language, pageCount, educationalMessage } = resolvedInput;

    // Phase B, Slice B3: this attempt's own claim namespace — every new
    // character sheet/image this run writes lands here, never derived from
    // Book.activeRunId, a fresh DB read, or any other source (see
    // generation-artifact-namespace.ts's ClaimArtifactNamespace doc
    // comment). GenerationResumeService also resolves the source pointer
    // unconditionally before its resumability check, so a malformed partial
    // pointer fails loudly even when this run will not reuse anything.
    const {
      resumable,
      currentNamespace,
      copyForwardSourceNamespace,
      priorCharacterProfile,
      reusableStory,
      priorSheet,
      canReuseCharacterProfile,
    } = await this.generationResumeService.plan(
      book,
      inputHash,
      ctx.runId,
      ctx.fencingVersion,
      resolvedInput.childPhoto?.sha256 ?? null,
    );
    const priorSheetStatus = priorSheet.status;

    // char_build: build the CharacterProfile (+ character-sheet reference
    // image) before the story itself, so every page/cover/back-cover prompt
    // built below can be seeded with it. Persisted below alongside whichever
    // update comes next (the failure-path update or Phase 1's layout
    // update), rather than as its own extra write.
    let charBuildResult: CharacterBuildStageOutput;
    let skippedCharacterProfileGeneration = false;
    let skippedCharacterSheetGeneration = false;

    await this.generationExecutionService.markStep(ctx, AgentStep.char_build);

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
        const sheetResult = await this.characterReferenceStage.regenerateSheet({
          bookId: book.id,
          characterProfile: priorCharacterProfile!,
          namespace: currentNamespace,
          telemetry: providerTelemetry,
          signal: ctx.signal,
        });
        charBuildResult = {
          ...sheetResult,
          providerName: profileProviderName,
          modelName: profileModelName,
        };
      }
    } else {
      charBuildResult = await this.characterReferenceStage.execute({
        bookId: book.id,
        input: resolvedInput,
        namespace: currentNamespace,
        telemetry: providerTelemetry,
        signal: ctx.signal,
      });
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

    const storyPhase = await this.storyQualityService.execute({
      generationInput: {
        bookId: book.id,
        childName,
        childAge,
        theme,
        language,
        pageCount,
        educationalMessage,
        characterProfile,
      },
      reusableStory: resumable ? reusableStory : null,
      targetPageCount,
      repairEnabled: storyRepairEnabled,
      telemetry: providerTelemetry,
      signal: ctx.signal,
      beforeStoryGeneration: () =>
        this.generationExecutionService.markStep(ctx, AgentStep.story_plan),
      beforeQualityReview: async () => {
        this.assertNotSuperseded(ctx, AgentStep.qa_review);
        await this.generationExecutionService.markStep(ctx, AgentStep.qa_review);
      },
    });

    if (storyPhase.kind === 'story_failure') {
      this.logger.error(`Story generation failed for book ${book.id}: ${storyPhase.errorMessage}`);
      return this.generationResultCollector.collectStoryFailureOutcome({
        bookId: book.id,
        traceId,
        generationTimeMs: Date.now() - startedAt,
        aiModelVersions,
        characterProfileUpdateData,
        charBuildResult,
        storyProviderName,
        storyModelName,
        errorMessage: storyPhase.errorMessage,
      });
    }

    const { story, qualityReport, skippedStoryGeneration, storyDurationMs, qualityDurationMs } =
      storyPhase;
    const { characterCard, storyPlan: storyPlanFinal, bookPreview } = story;
    let { imageGenerationResult } = story;

    this.logger.log(
      skippedStoryGeneration
        ? `Book ${book.id}: reusing ${bookPreview.pages.length} pages, ${imageGenerationResult.images.length} planned illustrations from the prior run.`
        : `Story generated for book ${book.id}: ${bookPreview.pages.length} pages, ${imageGenerationResult.images.length} illustrations planned (cover + pages + back cover).`,
    );

    if (storyPhase.kind === 'quality_failure') {
      this.logger.warn(
        `Book ${book.id} failed deterministic quality review with ${qualityReport.issues.length} finding(s).`,
      );
      return this.generationResultCollector.collectQualityFailureOutcome({
        bookId: book.id,
        traceId,
        generationTimeMs: Date.now() - startedAt,
        aiModelVersions,
        characterProfileUpdateData,
        charBuildResult,
        storyProviderName,
        storyModelName,
        storyDurationMs,
        qualityDurationMs,
        qualityReport,
      });
    }

    // A superseded run (heartbeat found a newer claim already owns it) is
    // signaled via ctx.signal — checked here, before the expensive/paid
    // image-generation step, so a fenced-out attempt stops doing real
    // provider/storage work as soon as it's detected, rather than only
    // discovering it much later when its final write is rejected anyway.
    this.assertNotSuperseded(ctx, AgentStep.image_gen);
    await this.generationExecutionService.markStep(ctx, AgentStep.image_gen);

    const imagePhase = await this.generationImageService.execute({
      bookId: book.id,
      ...(charBuildResult.characterSheetKey !== undefined && {
        characterSheetKey: charBuildResult.characterSheetKey,
      }),
      characterCard,
      result: imageGenerationResult,
      currentNamespace,
      sourceNamespace: copyForwardSourceNamespace,
      imageProviderName,
      telemetry: providerTelemetry,
      signal: ctx.signal,
    });
    imageGenerationResult = imagePhase.imageGenerationResult;
    const {
      characterReference,
      reusableImages,
      missingImagesBefore,
      invalidImagesBefore,
      generatedCount,
      failedCount,
      attemptedImageCount,
      imageDurationMs,
    } = imagePhase;
    await this.generationExecutionService.markStep(ctx, bookLayoutStage.step);
    const layoutStartedAt = Date.now();
    const bookLayout = bookLayoutStage.execute({
      bookId: book.id,
      bookPreview,
      imageGenerationResult,
    });
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
        qualityReport: qualityReport as unknown as Prisma.InputJsonValue,
        imageGenerationResult: imageGenerationResult as unknown as Prisma.InputJsonValue,
        bookLayout: bookLayout as unknown as Prisma.InputJsonValue,
        // Records which input produced this JSON — see GenerationResumeService's
        // comment. Written here (not on the earlier failure path, where
        // these fields are never set) since this is the only point at which
        // a later run can become resumable for this hash.
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
      bookLayoutStage.step,
    );

    // Phase 2: render PDF (pdf_render step) — checked again here for the same
    // reason as before image generation: a superseded attempt must not keep
    // doing storage/render work once it's been signaled.
    this.assertNotSuperseded(ctx, pdfPublicationStage.step);
    await this.generationExecutionService.markStep(ctx, pdfPublicationStage.step);

    let previewPdfUrl: string | null = null;
    let pdfRenderError: string | undefined;
    const pdfStartedAt = Date.now();

    try {
      const published = await pdfPublicationStage.execute({
        bookId: book.id,
        bookLayout,
        namespace: currentNamespace,
        imageAssetStorage: this.imageAssetStorage,
        pdfStorage: this.pdfStorage,
        logger: this.logger,
      });
      previewPdfUrl = published.previewPdfUrl;
    } catch (err) {
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
    // CharacterReferenceStage.loadReference) instead of reading ImageAssetStorage again for
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
      // (`sourceNamespace: null`), since the first classifyImages pass
      // above already resolved every reusable/copied entry for this claim.
      const afterImages = await this.generationResumeService.classifyImages(
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
    imageGenerationResult.resume = this.generationResultCollector.collectResumeDiagnostics({
      resumable,
      images: imageGenerationResult.images,
      priorSheetStatus,
      pdfStatusBefore,
      reusableImages,
      missingImagesBefore,
      invalidImagesBefore,
      generatedImageCount: generatedCount,
      skippedStoryGeneration,
      skippedCharacterProfileGeneration,
      skippedCharacterSheetGeneration,
      missingAssetsAfterRetry,
      pdfRenderSucceeded: !pdfRenderError,
      finalBookStatus: finalStatus,
    });

    // Not written here — see GenerationOutcome's doc comment. status/
    // errorMessage/failedStep are applied by the caller
    // (GenerationRunCoordinator.completeRun) atomically alongside the
    // GenerationRun terminal transition; everything else below rides along in
    // that same write.
    // GenerationResultCollector keeps terminal result/log assembly
    // deterministic. The caller still persists this outcome atomically (see
    // GenerationOutcome's doc comment), so a stale claim writes nothing.
    return this.generationResultCollector.collectOutcome({
      bookId: book.id,
      traceId,
      generationTimeMs: Date.now() - startedAt,
      aiModelVersions,
      imageGenerationResult,
      previewPdfUrl,
      finalStatus,
      ...(pdfRenderError && { pdfRenderError }),
      charBuildResult,
      storyProviderName,
      storyModelName,
      imageProviderName,
      imageModelName,
      storyDurationMs,
      qualityDurationMs,
      imageDurationMs,
      layoutDurationMs,
      pdfDurationMs,
      failedImageCount: failedCount,
      attemptedImageCount,
      layoutStep: bookLayoutStage.step,
      pdfStep: pdfPublicationStage.step,
    });
  }
}
