import { Inject, Injectable } from '@nestjs/common';
import type { GenerationProviderName } from '@book/types';
import type { GenerationStage } from './generation-stage';
import {
  STORY_GENERATION_PROVIDER_TOKEN,
  type StoryGenerationProvider,
  type StoryGenerationResult,
} from './story-generation-provider';
import { GenerationProviderTelemetry } from './generation-provider-telemetry';
import { validateStoryGenerationResult } from './story-generation-result-validator';
import { throwIfAborted } from '../common/provider-execution';

type StoryPromptInput = Parameters<StoryGenerationProvider['generateStory']>[0];

export interface StoryContentStageInput {
  prompt: StoryPromptInput;
  targetPageCount: number;
  telemetry: GenerationProviderTelemetry;
  signal?: AbortSignal | undefined;
}

function providerName(raw: string | undefined): GenerationProviderName {
  return raw === 'mock' || raw === 'openai' ? raw : 'unknown';
}

/**
 * Typed, bounded story stage: exactly one provider operation followed by the
 * deterministic result validator. Retry policy remains inside the selected
 * provider and telemetry budget; this stage never loops autonomously.
 */
@Injectable()
export class StoryContentStage implements GenerationStage<
  StoryContentStageInput,
  StoryGenerationResult
> {
  readonly step = 'story_plan' as const;

  constructor(
    @Inject(STORY_GENERATION_PROVIDER_TOKEN)
    private readonly provider: StoryGenerationProvider,
  ) {}

  async execute(input: StoryContentStageInput): Promise<StoryGenerationResult> {
    throwIfAborted(input.signal);
    const result = await input.telemetry.record({
      operation: 'story',
      provider: providerName(this.provider.providerName),
      ...(this.provider.modelName && { model: this.provider.modelName }),
      promptVersion: this.provider.promptVersion ?? 'legacy-story-v1',
      promptInput: input.prompt,
      execute: (options) =>
        this.provider.generateStory(input.prompt, {
          ...options,
          ...(input.signal && { signal: input.signal }),
        }),
    });
    throwIfAborted(input.signal);
    validateStoryGenerationResult(result, input.targetPageCount);
    return result;
  }
}
