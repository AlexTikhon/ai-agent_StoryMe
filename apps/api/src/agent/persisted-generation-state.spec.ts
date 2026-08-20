import { describe, expect, it } from 'vitest';
import { finalizeCharacterProfile } from './character-appearance';
import { parsePersistedGenerationState } from './persisted-generation-state';
import { MockStoryGenerationProvider } from './story-generation-provider';

const profile = finalizeCharacterProfile({
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

async function currentPersistedState() {
  const generated = await new MockStoryGenerationProvider().generateStory({
    bookId: 'book-1',
    childName: 'Mia',
    childAge: 7,
    theme: 'adventure',
    language: 'en',
    pageCount: 4,
    characterProfile: profile,
  });
  return { ...generated, characterProfile: profile };
}

describe('parsePersistedGenerationState', () => {
  it('returns typed reusable state for a complete current generation result', async () => {
    const persisted = await currentPersistedState();

    const parsed = parsePersistedGenerationState(persisted);

    expect(parsed.invalidFields).toEqual([]);
    expect(parsed.characterProfile).toEqual(profile);
    expect(parsed.reusableStory).toEqual({
      characterCard: persisted.characterCard,
      storyPlan: persisted.storyPlan,
      bookPreview: persisted.bookPreview,
      imageGenerationResult: persisted.imageGenerationResult,
    });
  });

  it('rejects malformed reusable product JSON without exposing its contents', async () => {
    const persisted = await currentPersistedState();
    const parsed = parsePersistedGenerationState({
      ...persisted,
      storyPlan: { title: 'private generated story text' },
      imageGenerationResult: { images: ['private prompt or bytes'] },
    });

    expect(parsed.reusableStory).toBeNull();
    expect(parsed.characterProfile).toEqual(profile);
    expect(parsed.invalidFields).toEqual(['storyPlan', 'imageGenerationResult']);
    expect(JSON.stringify(parsed.invalidFields)).not.toContain('private');
  });

  it('treats absent legacy progress as missing rather than malformed', () => {
    const parsed = parsePersistedGenerationState({
      characterProfile: null,
      characterCard: null,
      storyPlan: null,
      bookPreview: null,
      imageGenerationResult: null,
    });

    expect(parsed).toEqual({
      characterProfile: null,
      reusableStory: null,
      invalidFields: [],
    });
  });
});
