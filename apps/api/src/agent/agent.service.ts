import { Injectable, Logger } from '@nestjs/common';
import { AgentStep, Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../database/prisma.service';
import {
  CharacterReferenceStage,
  type CharacterBuildStageOutput,
} from './character-reference.stage';
import type { GenerationExecutionContext } from './generation-execution-context';
import {
  GenerationExecutionService,
  StaleGenerationRunError,
} from './generation-execution.service';
import { GenerationImageService } from './generation-image.service';
import type { GenerationOutcome } from './generation-outcome';
import { GenerationPreparationService } from './generation-preparation';
import { GenerationPublicationService } from './generation-publication.service';
import { GenerationResultCollector } from './generation-result.collector';
import { GenerationResumeService } from './generation-resume.service';
import { StoryQualityService } from './story-quality.service';

/** Thin deterministic workflow orchestrator for one claimed GenerationRun. */
@Injectable()
export class AgentService {
  private readonly logger = new Logger(AgentService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly preparation: GenerationPreparationService,
    private readonly execution: GenerationExecutionService,
    private readonly resume: GenerationResumeService,
    private readonly characterStage: CharacterReferenceStage,
    private readonly storyQuality: StoryQualityService,
    private readonly imageService: GenerationImageService,
    private readonly publication: GenerationPublicationService,
    private readonly collector: GenerationResultCollector,
  ) {}

  async startBookGeneration(ctx: GenerationExecutionContext): Promise<GenerationOutcome> {
    const book = await this.prisma.book.findUniqueOrThrow({ where: { id: ctx.bookId } });
    const traceId = randomUUID();
    const startedAt = Date.now();
    const prepared = this.preparation.prepare(ctx);
    const resolvedInput = prepared.input;

    const resumePlan = await this.resume.plan(
      book,
      ctx.inputHash,
      ctx.runId,
      ctx.fencingVersion,
      resolvedInput.childPhoto?.sha256 ?? null,
    );

    let charBuildResult: CharacterBuildStageOutput;
    let skippedCharacterProfileGeneration = false;
    let skippedCharacterSheetGeneration = false;

    await this.execution.markStep(ctx, AgentStep.char_build);
    if (resumePlan.canReuseCharacterProfile) {
      skippedCharacterProfileGeneration = true;
      if (resumePlan.priorSheet.status === 'valid') {
        skippedCharacterSheetGeneration = resumePlan.priorCharacterProfile!.hasCharacterSheet;
        charBuildResult = {
          characterProfile: resumePlan.priorCharacterProfile!,
          ...(resumePlan.priorSheet.key && { characterSheetKey: resumePlan.priorSheet.key }),
          providerName: prepared.characterProviderName,
          modelName: prepared.characterModelName,
          durationMs: 0,
        };
        this.logger.log(
          `Resuming book ${book.id}: reusing existing character profile${
            skippedCharacterSheetGeneration ? ' and character sheet' : ''
          } - skipping char_build generation.`,
        );
      } else {
        this.logger.warn(
          `Book ${book.id} has a character profile but its saved character-sheet bytes are ${resumePlan.priorSheet.status} - regenerating only the character sheet.`,
        );
        const sheet = await this.characterStage.regenerateSheet({
          bookId: book.id,
          characterProfile: resumePlan.priorCharacterProfile!,
          namespace: resumePlan.currentNamespace,
          telemetry: prepared.providerTelemetry,
          signal: ctx.signal,
        });
        charBuildResult = {
          ...sheet,
          providerName: prepared.characterProviderName,
          modelName: prepared.characterModelName,
        };
      }
    } else {
      charBuildResult = await this.characterStage.execute({
        bookId: book.id,
        input: resolvedInput,
        namespace: resumePlan.currentNamespace,
        telemetry: prepared.providerTelemetry,
        signal: ctx.signal,
      });
    }

    const characterProfileUpdateData: Prisma.BookUpdateInput = {
      characterProfile: charBuildResult.characterProfile as unknown as Prisma.InputJsonValue,
      ...(charBuildResult.characterSheetKey && {
        characterSheetAssetKey: charBuildResult.characterSheetKey,
      }),
    };

    const storyPhase = await this.storyQuality.execute({
      generationInput: {
        bookId: book.id,
        childName: resolvedInput.childName,
        childAge: resolvedInput.childAge,
        theme: resolvedInput.theme,
        language: resolvedInput.language,
        pageCount: resolvedInput.pageCount,
        educationalMessage: resolvedInput.educationalMessage,
        characterProfile: charBuildResult.characterProfile,
      },
      reusableStory: resumePlan.resumable ? resumePlan.reusableStory : null,
      targetPageCount: prepared.targetPageCount,
      repairEnabled: prepared.storyRepairEnabled,
      telemetry: prepared.providerTelemetry,
      signal: ctx.signal,
      beforeStoryGeneration: () => this.execution.markStep(ctx, AgentStep.story_plan),
      beforeQualityReview: async () => {
        this.assertNotSuperseded(ctx, AgentStep.qa_review);
        await this.execution.markStep(ctx, AgentStep.qa_review);
      },
    });

    if (storyPhase.kind === 'story_failure') {
      return this.collector.collectStoryFailureOutcome({
        bookId: book.id,
        traceId,
        generationTimeMs: Date.now() - startedAt,
        aiModelVersions: prepared.aiModelVersions,
        characterProfileUpdateData,
        charBuildResult,
        storyProviderName: prepared.storyProviderName,
        storyModelName: prepared.storyModelName,
        providerUsage: prepared.providerTelemetry.snapshot(),
        errorMessage: storyPhase.errorMessage,
      });
    }

    if (storyPhase.kind === 'quality_failure') {
      return this.collector.collectQualityFailureOutcome({
        bookId: book.id,
        traceId,
        generationTimeMs: Date.now() - startedAt,
        aiModelVersions: prepared.aiModelVersions,
        characterProfileUpdateData,
        charBuildResult,
        storyProviderName: prepared.storyProviderName,
        storyModelName: prepared.storyModelName,
        storyDurationMs: storyPhase.storyDurationMs,
        qualityDurationMs: storyPhase.qualityDurationMs,
        qualityReport: storyPhase.qualityReport,
        providerUsage: prepared.providerTelemetry.snapshot(),
      });
    }

    this.assertNotSuperseded(ctx, AgentStep.image_gen);
    await this.execution.markStep(ctx, AgentStep.image_gen);
    const imagePhase = await this.imageService.execute({
      bookId: book.id,
      ...(charBuildResult.characterSheetKey && {
        characterSheetKey: charBuildResult.characterSheetKey,
      }),
      characterCard: storyPhase.story.characterCard,
      result: storyPhase.story.imageGenerationResult,
      currentNamespace: resumePlan.currentNamespace,
      sourceNamespace: resumePlan.copyForwardSourceNamespace,
      imageProviderName: prepared.imageProviderName,
      telemetry: prepared.providerTelemetry,
      signal: ctx.signal,
    });

    return this.publication.publish({
      book,
      ctx,
      traceId,
      startedAt,
      prepared,
      story: storyPhase.story,
      qualityReport: storyPhase.qualityReport,
      charBuildResult,
      characterProfileUpdateData,
      currentNamespace: resumePlan.currentNamespace,
      imagePhase,
      priorSheetStatus: resumePlan.priorSheet.status,
      resumable: resumePlan.resumable,
      skippedStoryGeneration: storyPhase.skippedStoryGeneration,
      skippedCharacterProfileGeneration,
      skippedCharacterSheetGeneration,
      storyDurationMs: storyPhase.storyDurationMs,
      qualityDurationMs: storyPhase.qualityDurationMs,
    });
  }

  private assertNotSuperseded(ctx: GenerationExecutionContext, step: AgentStep): void {
    if (ctx.signal?.aborted) throw new StaleGenerationRunError(ctx.runId, step);
  }
}
