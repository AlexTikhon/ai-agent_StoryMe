import { describe, expect, it } from 'vitest';
import { MockCharacterProfileProvider } from './character-profile-provider';
import { MockStoryGenerationProvider } from './story-generation-provider';
import {
  StoryGenerationResultValidationError,
  validateStoryGenerationResult,
} from './story-generation-result-validator';

async function validResult() {
  const profile = await new MockCharacterProfileProvider().buildProfile({
    bookId: 'book-1',
    childName: 'Mia',
    childAge: 7,
    theme: 'forest',
    language: 'en',
  });
  return new MockStoryGenerationProvider().generateStory({
    bookId: 'book-1',
    childName: 'Mia',
    childAge: 7,
    theme: 'forest',
    language: 'en',
    pageCount: 6,
    characterProfile: profile,
  });
}

describe('validateStoryGenerationResult', () => {
  it('accepts a complete provider result whose artifacts agree', async () => {
    const result = await validResult();
    expect(() => validateStoryGenerationResult(result, 6)).not.toThrow();
  });

  it('rejects a missing planned image', async () => {
    const result = await validResult();
    result.imageGenerationResult.images.pop();
    expect(() => validateStoryGenerationResult(result, 6)).toThrow(
      StoryGenerationResultValidationError,
    );
  });

  it('rejects non-contiguous story pages', async () => {
    const result = await validResult();
    result.storyPlan.pages[1]!.pageNumber = 4;
    expect(() => validateStoryGenerationResult(result, 6)).toThrow(/contiguous/);
  });

  it('rejects image prompts missing deterministic safety instructions', async () => {
    const result = await validResult();
    result.imageGenerationResult.images[0]!.prompt = 'a plain illustration';
    expect(() => validateStoryGenerationResult(result, 6)).toThrow(/safety instructions/);
  });
});
