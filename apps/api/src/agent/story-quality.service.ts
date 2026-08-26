import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import type { ProviderFailureKind, QualityReport } from '@book/types';
import { StoryContentStage } from './story-content.stage';
import { evaluateStoryQuality } from './story-quality-gate';
import { StoryQualityRepairStage } from './story-quality-repair.stage';
import {
  type StoryGenerationInput,
  type StoryGenerationProvider,
  STORY_GENERATION_PROVIDER_TOKEN,
  type StoryGenerationResult,
} from './story-generation-provider';
import type { GenerationProviderTelemetry } from './generation-provider-telemetry';
import { StaleGenerationRunError } from './generation-execution.service';
import {
  classifyProviderFailure,
  isProviderCancellationError,
  safeProviderFailureMessage,
  throwIfAborted,
} from '../common/provider-execution';
import { bindCharacterProfileToStoryResult } from './mock-story-builders';

export interface StoryQualityPhaseInput {
  generationInput: StoryGenerationInput;
  reusableStory: StoryGenerationResult | null;
  targetPageCount: number;
  repairEnabled: boolean;
  telemetry: GenerationProviderTelemetry;
  signal?: AbortSignal | undefined;
  beforeStoryGeneration: () => Promise<void>;
  beforeQualityReview: () => Promise<void>;
}

export type StoryQualityPhaseResult =
  | {
      kind: 'story_failure';
      errorMessage: string;
      failureKind: ProviderFailureKind;
    }
  | {
      kind: 'quality_failure';
      story: StoryGenerationResult;
      qualityReport: QualityReport;
      skippedStoryGeneration: boolean;
      storyDurationMs: number;
      qualityDurationMs: number;
    }
  | {
      kind: 'success';
      story: StoryGenerationResult;
      qualityReport: QualityReport;
      skippedStoryGeneration: boolean;
      storyDurationMs: number;
      qualityDurationMs: number;
    };

/**
 * Deterministic story boundary: reuse or one story generation, deterministic
 * review, and at most one optional repair followed by deterministic review.
 */
export const STORY_QUALITY_CLOCK_TOKEN = 'STORY_QUALITY_CLOCK';

@Injectable()
export class StoryQualityService {
  private readonly logger = new Logger(StoryQualityService.name);

  constructor(
    @Inject(STORY_GENERATION_PROVIDER_TOKEN)
    private readonly provider: StoryGenerationProvider,
    private readonly contentStage: StoryContentStage,
    private readonly repairStage: StoryQualityRepairStage,
    @Optional()
    @Inject(STORY_QUALITY_CLOCK_TOKEN)
    private readonly now: () => number = Date.now,
  ) {}

  async execute(input: StoryQualityPhaseInput): Promise<StoryQualityPhaseResult> {
    let story: StoryGenerationResult;
    let storyDurationMs = 0;
    const skippedStoryGeneration = input.reusableStory !== null;

    if (input.reusableStory) {
      story = bindCharacterProfileToStoryResult(input.generationInput, input.reusableStory);
    } else {
      await input.beforeStoryGeneration();
      const storyStartedAt = this.now();
      try {
        story = await this.contentStage.execute({
          prompt: input.generationInput,
          targetPageCount: input.targetPageCount,
          telemetry: input.telemetry,
          signal: input.signal,
        });
      } catch (error) {
        throwIfAborted(input.signal);
        if (error instanceof StaleGenerationRunError || isProviderCancellationError(error)) {
          throw error;
        }
        return {
          kind: 'story_failure',
          errorMessage: safeProviderFailureMessage(error),
          failureKind: classifyProviderFailure(error),
        };
      }
      storyDurationMs = this.now() - storyStartedAt;
    }

    await input.beforeQualityReview();
    const qualityStartedAt = this.now();
    const qualityInput = {
      childName: input.generationInput.childName,
      childAge: input.generationInput.childAge,
      language: input.generationInput.language,
      theme: input.generationInput.theme,
      pageCount: input.targetPageCount,
      ...(input.generationInput.educationalMessage !== undefined && {
        educationalMessage: input.generationInput.educationalMessage,
      }),
    };
    let qualityReport = evaluateStoryQuality(story, qualityInput);

    const repairableFailure =
      !qualityReport.overallPassed &&
      qualityReport.issues
        .filter((finding) => finding.severity === 'error')
        .every((finding) => finding.repairable);

    if (input.repairEnabled && repairableFailure && this.provider.repairStory) {
      try {
        const repaired = await this.repairStage.execute({
          repairInput: {
            generationInput: input.generationInput,
            candidate: story,
            qualityReport,
          },
          targetPageCount: input.targetPageCount,
          telemetry: input.telemetry,
          signal: input.signal,
        });
        const repairedReport = evaluateStoryQuality(repaired, qualityInput);
        const providerCall = input.telemetry
          .snapshot()
          .calls.filter((call) => call.operation === 'story_repair')
          .at(-1);
        qualityReport = {
          ...repairedReport,
          repair: {
            attempted: true,
            outcome: repairedReport.overallPassed ? 'passed' : 'failed_validation',
            ...(providerCall && { providerCall }),
          },
        };
        if (qualityReport.overallPassed) story = repaired;
      } catch (error) {
        throwIfAborted(input.signal);
        if (isProviderCancellationError(error)) throw error;
        const providerCall = input.telemetry
          .snapshot()
          .calls.filter((call) => call.operation === 'story_repair')
          .at(-1);
        qualityReport = {
          ...qualityReport,
          repair: {
            attempted: true,
            outcome: 'provider_error',
            ...(providerCall && { providerCall }),
          },
        };
        this.logger.warn(`Book ${input.generationInput.bookId}: bounded story repair failed.`);
      }
    }

    const common = {
      story,
      qualityReport,
      skippedStoryGeneration,
      storyDurationMs,
      qualityDurationMs: this.now() - qualityStartedAt,
    };
    return qualityReport.overallPassed
      ? { kind: 'success', ...common }
      : { kind: 'quality_failure', ...common };
  }
}
