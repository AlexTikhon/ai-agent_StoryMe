import { describe, expect, it, vi } from 'vitest';
import { finalizeCharacterProfile } from './character-appearance';
import { GenerationProviderTelemetry } from './generation-provider-telemetry';
import {
  MockStoryGenerationProvider,
  type StoryGenerationProvider,
} from './story-generation-provider';
import { StoryContentStage } from './story-content.stage';
import { StoryQualityRepairStage } from './story-quality-repair.stage';
import { StoryQualityService } from './story-quality.service';
import { ProviderCancellationError } from '../common/provider-execution';

const characterProfile = finalizeCharacterProfile({
  childName: 'Mia',
  age: 7,
  visualDescription: 'Mia the explorer',
  faceDescription: 'friendly face',
  hairDescription: 'brown hair',
  outfitDescription: 'yellow spacesuit',
  personalitySummary: 'curious',
  illustrationStyle: 'storybook',
  consistencyPrompt: 'same explorer',
  hasReferencePhoto: false,
  hasCharacterSheet: false,
});

const generationInput = {
  bookId: 'book-1',
  childName: 'Mia',
  childAge: 7,
  theme: 'adventure',
  language: 'en',
  pageCount: 4,
  educationalMessage: undefined,
  characterProfile,
};

function callbacks() {
  return {
    beforeStoryGeneration: vi.fn(async () => undefined),
    beforeQualityReview: vi.fn(async () => undefined),
  };
}

function makeService(
  provider: StoryGenerationProvider,
  now: () => number = Date.now,
): StoryQualityService {
  return new StoryQualityService(
    provider,
    new StoryContentStage(provider),
    new StoryQualityRepairStage(provider),
    now,
  );
}

describe('StoryQualityService', () => {
  it('reuses validated story state without another story provider call', async () => {
    const generated = await new MockStoryGenerationProvider().generateStory(generationInput);
    const generateStory = vi.fn(async () => generated);
    const service = makeService({ providerName: 'mock', generateStory });
    const hooks = callbacks();

    const result = await service.execute({
      generationInput,
      reusableStory: generated,
      targetPageCount: 4,
      repairEnabled: false,
      telemetry: new GenerationProviderTelemetry(20, 0),
      ...hooks,
    });

    expect(result.kind).toBe('success');
    expect(generateStory).not.toHaveBeenCalled();
    expect(hooks.beforeStoryGeneration).not.toHaveBeenCalled();
    expect(hooks.beforeQualityReview).toHaveBeenCalledOnce();
  });

  it('performs at most one repair and revalidates the repaired result', async () => {
    const valid = await new MockStoryGenerationProvider().generateStory(generationInput);
    const invalid = {
      ...valid,
      bookPreview: {
        ...valid.bookPreview,
        metadata: { ...valid.bookPreview.metadata, theme: 'wrong-theme' },
      },
    };
    const repairStory = vi.fn(async () => valid);
    const service = makeService({
      providerName: 'mock',
      promptVersion: 'test-v1',
      generateStory: vi.fn(async () => invalid),
      repairStory,
    });
    const telemetry = new GenerationProviderTelemetry(20, 0);

    const result = await service.execute({
      generationInput,
      reusableStory: null,
      targetPageCount: 4,
      repairEnabled: true,
      telemetry,
      ...callbacks(),
    });

    expect(result.kind).toBe('success');
    if (result.kind !== 'success') throw new Error('Expected successful repair');
    expect(result.qualityReport.repair?.outcome).toBe('passed');
    expect(repairStory).toHaveBeenCalledOnce();
    expect(telemetry.snapshot().calls.map(({ operation }) => operation)).toEqual([
      'story',
      'story_repair',
    ]);
  });

  it('measures story and quality from their own stage-local clocks', async () => {
    const generated = await new MockStoryGenerationProvider().generateStory(generationInput);
    const ticks = [100, 135, 140, 152];
    const service = makeService(
      { providerName: 'mock', generateStory: vi.fn(async () => generated) },
      () => ticks.shift()!,
    );

    const result = await service.execute({
      generationInput,
      reusableStory: null,
      targetPageCount: 4,
      repairEnabled: false,
      telemetry: new GenerationProviderTelemetry(20, 0),
      ...callbacks(),
    });

    expect(result.kind).toBe('success');
    if (result.kind !== 'success') throw new Error('Expected success');
    expect(result.storyDurationMs).toBe(35);
    expect(result.qualityDurationMs).toBe(12);
  });

  it('propagates cancellation during repair instead of recording provider_error', async () => {
    const valid = await new MockStoryGenerationProvider().generateStory(generationInput);
    const invalid = {
      ...valid,
      bookPreview: {
        ...valid.bookPreview,
        metadata: { ...valid.bookPreview.metadata, theme: 'wrong-theme' },
      },
    };
    const service = makeService({
      providerName: 'openai',
      generateStory: vi.fn(async () => invalid),
      repairStory: vi.fn().mockRejectedValue(new ProviderCancellationError()),
    });

    await expect(
      service.execute({
        generationInput,
        reusableStory: null,
        targetPageCount: 4,
        repairEnabled: true,
        telemetry: new GenerationProviderTelemetry(20, 0),
        ...callbacks(),
      }),
    ).rejects.toBeInstanceOf(ProviderCancellationError);
  });
});
