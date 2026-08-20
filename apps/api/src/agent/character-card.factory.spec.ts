import { describe, expect, it } from 'vitest';
import { finalizeCharacterProfile } from './character-appearance';
import { createCharacterCard } from './character-card.factory';
import { MockStoryGenerationProvider } from './mock-story-generation-provider';

const profile = finalizeCharacterProfile(
  {
    childName: 'Nova',
    age: 8,
    visualDescription: 'Nova is a confident explorer',
    faceDescription: 'heart-shaped face with a small dimple',
    hairDescription: 'straight light-blonde hair in a low ponytail',
    outfitDescription: 'a cobalt-blue jacket with silver buttons',
    personalitySummary: 'patient and confident',
    illustrationStyle: 'layered paper-cut storybook illustration',
    consistencyPrompt: 'legacy text',
    hasReferencePhoto: false,
    hasCharacterSheet: false,
  },
  { eyeDescription: 'large expressive green eyes' },
);

describe('createCharacterCard', () => {
  it('projects identity from CharacterProfile without legacy appearance fabrication', () => {
    const card = createCharacterCard(profile);
    expect(card.visualAnchor).toBe(profile.lockedVisualDescription);
    expect(card.narrativeDescription).toBe(profile.personalitySummary);
    expect(card.appearance).toBeUndefined();
    expect(JSON.stringify(card)).not.toMatch(/wavy brown hair|"skinTone":"medium"/i);
  });

  it('keeps mock cover, page, and back-cover prompts on the same canonical identity', async () => {
    const result = await new MockStoryGenerationProvider().generateStory({
      bookId: 'book-nova',
      childName: 'Nova',
      childAge: 8,
      theme: 'space',
      language: 'en',
      pageCount: 4,
      characterProfile: profile,
    });

    expect(result.characterCard.visualAnchor).toBe(profile.lockedVisualDescription);
    for (const entry of result.imageGenerationResult.images) {
      expect(entry.prompt).toContain(profile.lockedVisualDescription);
      expect(entry.prompt.match(/LOCKED CHARACTER: Nova/g)).toHaveLength(1);
      expect(entry.prompt).not.toMatch(/wavy brown hair|medium skin tone/i);
    }
  });
});
