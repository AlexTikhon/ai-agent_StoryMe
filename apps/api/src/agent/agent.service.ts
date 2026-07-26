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
import { type BookPreview, type ImageGenerationResult } from '@book/types';
import {
  STORY_GENERATION_PROVIDER_TOKEN,
  resolveTargetPageCount,
  type StoryGenerationProvider,
  type StoryGenerationResult,
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
  GenerationProviderTelemetry,
  requiredPaidProviderCallsForBook,
  resolveMaxPaidProviderCallsPerRun,
} from './generation-provider-telemetry';
import { StoryContentStage } from './story-content.stage';
import {
  CharacterReferenceStage,
  type CharacterBuildStageOutput,
} from './character-reference.stage';
import { ImageGenerationStage, imageAssetLabel } from './image-generation.stage';
import { GenerationResumeService } from './generation-resume.service';
import { GenerationResultCollector } from './generation-result.collector';

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

@Injectable()
export class AgentService {
  private readonly logger = new Logger(AgentService.name);
  private readonly storyContentStage: StoryContentStage;
  private readonly characterReferenceStage: CharacterReferenceStage;
  private readonly imageGenerationStage: ImageGenerationStage;
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
    this.storyContentStage = new StoryContentStage(storyGenerationProvider);
    this.characterReferenceStage = new CharacterReferenceStage(
      imageAssetStorage,
      characterProfileProvider,
      imageGenerationProvider,
    );
    this.imageGenerationStage = new ImageGenerationStage(
      imageAssetStorage,
      imageGenerationProvider,
    );
    this.generationResumeService = new GenerationResumeService(imageAssetStorage);
  }

  /** Safe label for Book.aiModelVersions — never empty, never a secret ('mock' when no real model applies). */
  private modelLabel(provider: {
    readonly providerName?: string;
    readonly modelName?: string;
  }): string {
    return provider.modelName ?? provider.providerName ?? 'unknown';
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
    const targetPageCount = resolveTargetPageCount(pageCount);
    const plannedPaidCalls = requiredPaidProviderCallsForBook(targetPageCount, {
      storyProvider: this.storyGenerationProvider.providerName,
      characterProfileProvider: this.characterProfileProvider.providerName,
      imageProvider: this.imageGenerationProvider.providerName,
    });
    const providerTelemetry = new GenerationProviderTelemetry(
      resolveMaxPaidProviderCallsPerRun(),
      plannedPaidCalls,
    );
    const aiModelVersions = {
      story: this.modelLabel(this.storyGenerationProvider),
      image: this.modelLabel(this.imageGenerationProvider),
    };

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
      priorSheet,
      canReuseCharacterProfile,
    } = await this.generationResumeService.plan(book, inputHash, ctx.runId, ctx.fencingVersion);
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
        await this.generationExecutionService.markStep(ctx, AgentStep.story_plan);
        const storyPromptInput = {
          bookId: book.id,
          childName,
          childAge,
          theme,
          language,
          pageCount,
          educationalMessage,
          characterProfile,
        };
        const result = await this.storyContentStage.execute({
          prompt: storyPromptInput,
          targetPageCount,
          telemetry: providerTelemetry,
        });
        characterCard = result.characterCard;
        storyPlanFinal = result.storyPlan;
        bookPreview = result.bookPreview;
        imageGenerationResult = result.imageGenerationResult;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.error(`Story generation failed for book ${book.id}: ${message}`);
        return this.generationResultCollector.collectStoryFailureOutcome({
          bookId: book.id,
          traceId,
          generationTimeMs: Date.now() - startedAt,
          aiModelVersions,
          characterProfileUpdateData,
          charBuildResult,
          storyProviderName,
          storyModelName,
          errorMessage: message,
        });
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
    await this.generationExecutionService.markStep(ctx, AgentStep.image_gen);

    const imageStartedAt = Date.now();

    const { reference: characterReference, loadError: characterReferenceLoadError } =
      await this.characterReferenceStage.loadReference(book.id, charBuildResult.characterSheetKey);
    const characterReferenceAvailable = characterReference !== undefined;

    // Idempotent resume: only call the image provider for entries whose
    // current-claim bytes are missing or invalid and no source copy-forward
    // resolves them either; entries with a valid current-claim asset (or a
    // valid, successfully copy-forwarded source one — see
    // GenerationResumeService.classifyImages/generation-claim-artifacts.ts) are reused
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
    } = await this.generationResumeService.classifyImages(
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

    const imageGeneration = await this.imageGenerationStage.execute({
      bookId: book.id,
      characterCard,
      images: imagesNeedingGeneration,
      ...(characterReference && { characterReference }),
      namespace: currentNamespace,
      telemetry: providerTelemetry,
    });
    const { generatedCount, failedCount, usedCharacterReference } = imageGeneration;

    const rateLimitDiagnostics = this.imageGenerationProvider.getRateLimitDiagnostics?.();
    const rateLimitSummary = rateLimitDiagnostics
      ? ` rateLimit: requestsQueued=${rateLimitDiagnostics.requestsQueued} totalWaitMs=${rateLimitDiagnostics.totalWaitMs} rateLimitHits=${rateLimitDiagnostics.rateLimitHits} retriesUsed=${rateLimitDiagnostics.retriesUsed} retryAfterHonored=${rateLimitDiagnostics.retryAfterHonoredCount}.`
      : '';
    this.logger.log(
      `Image generation for book ${book.id}: ${generatedCount} generated, ${reusableImages.length} reused, ${failedCount} failed, ${imageGenerationResult.images.length} planned, characterReferenceAvailable=${characterReferenceAvailable}, characterReferenceUsedForImages=${usedCharacterReference}.${rateLimitSummary}`,
    );

    imageGenerationResult = this.generationResultCollector.collectImageResult({
      result: imageGenerationResult,
      imageProviderName,
      reusableImageCount: reusableImages.length,
      attemptedImageCount: imagesNeedingGeneration.length,
      generation: imageGeneration,
      characterReferenceAvailable,
      characterReferenceSupplied: characterReference !== undefined,
      ...(characterReferenceLoadError !== undefined && { characterReferenceLoadError }),
      providerUsage: providerTelemetry.snapshot(),
    });

    const imageDurationMs = Date.now() - imageStartedAt;
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
      imageDurationMs,
      layoutDurationMs,
      pdfDurationMs,
      failedImageCount: failedCount,
      attemptedImageCount: imagesNeedingGeneration.length,
      layoutStep: bookLayoutStage.step,
      pdfStep: pdfPublicationStage.step,
    });
  }
}
