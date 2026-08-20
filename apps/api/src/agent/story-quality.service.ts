import { Logger } from '@nestjs/common';
import type { QualityReport } from '@book/types';
import { StoryContentStage } from './story-content.stage';
import { evaluateStoryQuality } from './story-quality-gate';
import { StoryQualityRepairStage } from './story-quality-repair.stage';
import type {
  StoryGenerationInput,
  StoryGenerationProvider,
  StoryGenerationResult,
} from './story-generation-provider';
import type { GenerationProviderTelemetry } from './generation-provider-telemetry';
import { StaleGenerationRunError } from './generation-execution.service';

export interface StoryQualityPhaseInput {
  generationInput: StoryGenerationInput;
  reusableStory: StoryGenerationResult | null;
  targetPageCount: number;
  repairEnabled: boolean;
  telemetry: GenerationProviderTelemetry;
  generationStartedAt: number;
  beforeStoryGeneration: () => Promise<void>;
  beforeQualityReview: () => Promise<void>;
}

export type StoryQualityPhaseResult =
  | {
      kind: 'story_failure';
      errorMessage: string;
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
export class StoryQualityService {
  private readonly logger = new Logger(StoryQualityService.name);
  private readonly contentStage: StoryContentStage;
  private readonly repairStage: StoryQualityRepairStage;

  constructor(private readonly provider: StoryGenerationProvider) {
    this.contentStage = new StoryContentStage(provider);
    this.repairStage = new StoryQualityRepairStage(provider);
  }

  async execute(input: StoryQualityPhaseInput): Promise<StoryQualityPhaseResult> {
    let story: StoryGenerationResult;
    const skippedStoryGeneration = input.reusableStory !== null;

    if (input.reusableStory) {
      story = input.reusableStory;
    } else {
      await input.beforeStoryGeneration();
      try {
        story = await this.contentStage.execute({
          prompt: input.generationInput,
          targetPageCount: input.targetPageCount,
          telemetry: input.telemetry,
        });
      } catch (error) {
        if (error instanceof StaleGenerationRunError) throw error;
        return {
          kind: 'story_failure',
          errorMessage: error instanceof Error ? error.message : String(error),
        };
      }
    }

    const storyDurationMs = skippedStoryGeneration ? 0 : Date.now() - input.generationStartedAt;
    await input.beforeQualityReview();
    const qualityStartedAt = Date.now();
    const qualityInput = {
      childName: input.generationInput.childName,
      childAge: input.generationInput.childAge,
      language: input.generationInput.language,
      theme: input.generationInput.theme,
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
      } catch {
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
      qualityDurationMs: Date.now() - qualityStartedAt,
    };
    return qualityReport.overallPassed
      ? { kind: 'success', ...common }
      : { kind: 'quality_failure', ...common };
  }
}
