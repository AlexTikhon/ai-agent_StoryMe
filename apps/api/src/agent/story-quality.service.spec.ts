import { describe, expect, it, vi } from 'vitest';
import { finalizeCharacterProfile } from './character-appearance';
import { GenerationProviderTelemetry } from './generation-provider-telemetry';
import { MockStoryGenerationProvider } from './story-generation-provider';
import { StoryQualityService } from './story-quality.service';

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

describe('StoryQualityService', () => {
  it('reuses validated story state without another story provider call', async () => {
    const generated = await new MockStoryGenerationProvider().generateStory(generationInput);
    const generateStory = vi.fn(async () => generated);
    const service = new StoryQualityService({ providerName: 'mock', generateStory });
    const hooks = callbacks();

    const result = await service.execute({
      generationInput,
      reusableStory: generated,
      targetPageCount: 4,
      repairEnabled: false,
      telemetry: new GenerationProviderTelemetry(20, 0),
      generationStartedAt: Date.now(),
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
    const service = new StoryQualityService({
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
      generationStartedAt: Date.now(),
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
});
