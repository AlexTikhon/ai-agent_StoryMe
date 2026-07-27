import type { GenerationProviderName } from '@book/types';
import type { GenerationStage } from './generation-stage';
import { GenerationProviderTelemetry } from './generation-provider-telemetry';
import type {
  StoryGenerationProvider,
  StoryGenerationResult,
  StoryRepairInput,
} from './story-generation-provider';
import { validateStoryGenerationResult } from './story-generation-result-validator';

export interface StoryQualityRepairStageInput {
  repairInput: StoryRepairInput;
  targetPageCount: number;
  telemetry: GenerationProviderTelemetry;
}

export class StoryRepairUnavailableError extends Error {
  constructor() {
    super('The configured story provider does not support bounded repair.');
    this.name = 'StoryRepairUnavailableError';
  }
}

export function resolveStoryRepairEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env['STORY_REPAIR_ENABLED']?.trim().toLowerCase() === 'true';
}

function providerName(raw: string | undefined): GenerationProviderName {
  return raw === 'mock' || raw === 'openai' ? raw : 'unknown';
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) {
      deepFreeze(nested);
    }
  }
  return value;
}

/**
 * Phase 5B's entire repair boundary: exactly one provider invocation and one
 * structural validation. It contains no retry/reflection loop; HTTP retry
 * policy remains bounded inside the selected provider.
 */
export class StoryQualityRepairStage implements GenerationStage<
  StoryQualityRepairStageInput,
  StoryGenerationResult
> {
  readonly step = 'qa_review' as const;

  constructor(private readonly provider: StoryGenerationProvider) {}

  async execute(input: StoryQualityRepairStageInput): Promise<StoryGenerationResult> {
    if (!this.provider.repairStory) {
      throw new StoryRepairUnavailableError();
    }

    const immutableInput = deepFreeze(structuredClone(input.repairInput));
    const result = await input.telemetry.record({
      operation: 'story_repair',
      provider: providerName(this.provider.providerName),
      ...(this.provider.modelName && { model: this.provider.modelName }),
      promptVersion: `${this.provider.promptVersion ?? 'legacy-story-v1'}-repair-v1`,
      promptInput: immutableInput,
      execute: () => this.provider.repairStory!(immutableInput),
    });
    validateStoryGenerationResult(result, input.targetPageCount);
    return result;
  }
}
