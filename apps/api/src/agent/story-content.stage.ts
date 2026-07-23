import type { GenerationProviderName } from '@book/types';
import type { GenerationStage } from './generation-stage';
import type { StoryGenerationProvider, StoryGenerationResult } from './story-generation-provider';
import { GenerationProviderTelemetry } from './generation-provider-telemetry';
import { validateStoryGenerationResult } from './story-generation-result-validator';

type StoryPromptInput = Parameters<StoryGenerationProvider['generateStory']>[0];

export interface StoryContentStageInput {
  prompt: StoryPromptInput;
  targetPageCount: number;
  telemetry: GenerationProviderTelemetry;
}

function providerName(raw: string | undefined): GenerationProviderName {
  return raw === 'mock' || raw === 'openai' ? raw : 'unknown';
}

/**
 * Typed, bounded story stage: exactly one provider operation followed by the
 * deterministic result validator. Retry policy remains inside the selected
 * provider and telemetry budget; this stage never loops autonomously.
 */
export class StoryContentStage implements GenerationStage<
  StoryContentStageInput,
  StoryGenerationResult
> {
  readonly step = 'story_plan' as const;

  constructor(private readonly provider: StoryGenerationProvider) {}

  async execute(input: StoryContentStageInput): Promise<StoryGenerationResult> {
    const result = await input.telemetry.record({
      operation: 'story',
      provider: providerName(this.provider.providerName),
      ...(this.provider.modelName && { model: this.provider.modelName }),
      promptVersion: this.provider.promptVersion ?? 'legacy-story-v1',
      promptInput: input.prompt,
      execute: () => this.provider.generateStory(input.prompt),
    });
    validateStoryGenerationResult(result, input.targetPageCount);
    return result;
  }
}
