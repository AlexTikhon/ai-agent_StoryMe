import { describe, expect, it, vi } from 'vitest';
import type { CharacterProfile, QualityReport } from '@book/types';
import { GenerationProviderTelemetry } from './generation-provider-telemetry';
import {
  MockStoryGenerationProvider,
  type StoryGenerationInput,
  type StoryGenerationProvider,
} from './story-generation-provider';
import {
  StoryQualityRepairStage,
  StoryRepairUnavailableError,
  resolveStoryRepairEnabled,
} from './story-quality-repair.stage';

const characterProfile: CharacterProfile = {
  childName: 'Mia',
  age: 5,
  visualDescription: 'friendly child',
  faceDescription: 'round friendly face',
  hairDescription: 'wavy brown hair',
  outfitDescription: 'yellow overalls',
  personalitySummary: 'kind and curious',
  illustrationStyle: 'warm picture book',
  consistencyPrompt: 'Mia with wavy brown hair and yellow overalls',
  hasReferencePhoto: false,
  hasCharacterSheet: false,
};

const generationInput: StoryGenerationInput = {
  bookId: 'book-1',
  childName: 'Mia',
  childAge: 5,
  theme: 'friendship',
  language: 'en',
  characterProfile,
};

const qualityReport: QualityReport = {
  version: 1,
  overallPassed: false,
  issues: [
    {
      code: 'metadata_theme_mismatch',
      category: 'alignment',
      severity: 'error',
      repairable: true,
      message: 'Generated theme metadata does not match the requested theme.',
    },
  ],
  flaggedPages: [],
};

function telemetry() {
  return new GenerationProviderTelemetry(1, 0, {});
}

describe('StoryQualityRepairStage', () => {
  it('resolves the feature flag only for an explicit true value', () => {
    expect(resolveStoryRepairEnabled({ STORY_REPAIR_ENABLED: 'true' })).toBe(true);
    expect(resolveStoryRepairEnabled({ STORY_REPAIR_ENABLED: 'TRUE' })).toBe(true);
    expect(resolveStoryRepairEnabled({ STORY_REPAIR_ENABLED: 'false' })).toBe(false);
    expect(resolveStoryRepairEnabled({})).toBe(false);
  });

  it('invokes the typed repair capability exactly once and records safe telemetry', async () => {
    const candidate = await new MockStoryGenerationProvider().generateStory(generationInput);
    const repairStory = vi.fn().mockResolvedValue(candidate);
    const provider: StoryGenerationProvider = {
      providerName: 'mock',
      promptVersion: 'test-story-v1',
      generateStory: vi.fn(),
      repairStory,
    };
    const usage = telemetry();

    const result = await new StoryQualityRepairStage(provider).execute({
      repairInput: { generationInput, candidate, qualityReport },
      targetPageCount: 6,
      telemetry: usage,
    });

    expect(result).toBe(candidate);
    expect(repairStory).toHaveBeenCalledTimes(1);
    expect(Object.isFrozen(repairStory.mock.calls[0]?.[0])).toBe(true);
    expect(usage.snapshot().calls).toEqual([
      expect.objectContaining({
        operation: 'story_repair',
        provider: 'mock',
        promptVersion: 'test-story-v1-repair-v1',
        status: 'success',
      }),
    ]);
    expect(JSON.stringify(usage.snapshot())).not.toContain('Mia');
  });

  it('does not retry when the repaired candidate fails structural validation', async () => {
    const candidate = await new MockStoryGenerationProvider().generateStory(generationInput);
    const repairStory = vi.fn().mockResolvedValue({
      ...candidate,
      bookPreview: { ...candidate.bookPreview, pages: [] },
    });
    const provider: StoryGenerationProvider = {
      providerName: 'mock',
      generateStory: vi.fn(),
      repairStory,
    };

    await expect(
      new StoryQualityRepairStage(provider).execute({
        repairInput: { generationInput, candidate, qualityReport },
        targetPageCount: 6,
        telemetry: telemetry(),
      }),
    ).rejects.toThrow();
    expect(repairStory).toHaveBeenCalledTimes(1);
  });

  it('fails closed when the selected provider has no repair capability', async () => {
    const provider = new MockStoryGenerationProvider();
    const candidate = await provider.generateStory(generationInput);

    await expect(
      new StoryQualityRepairStage(provider).execute({
        repairInput: { generationInput, candidate, qualityReport },
        targetPageCount: 6,
        telemetry: telemetry(),
      }),
    ).rejects.toBeInstanceOf(StoryRepairUnavailableError);
  });
});
