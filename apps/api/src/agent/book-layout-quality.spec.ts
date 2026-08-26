import { describe, expect, it } from 'vitest';
import { MockCharacterProfileProvider } from './character-profile-provider';
import { MockStoryGenerationProvider } from './story-generation-provider';
import { BookLayoutStage } from './book-layout.stage';
import { assertBookLayoutQuality, BookLayoutQualityError } from './book-layout-quality';

async function layout() {
  const input = {
    bookId: 'layout-quality-book',
    childName: 'Mia',
    childAge: 6,
    language: 'en',
    theme: 'forest adventure',
    pageCount: 4,
  };
  const characterProfile = await new MockCharacterProfileProvider().buildProfile(input);
  const story = await new MockStoryGenerationProvider().generateStory({
    ...input,
    characterProfile,
  });
  return new BookLayoutStage().execute({
    bookId: input.bookId,
    bookPreview: story.bookPreview,
    imageGenerationResult: story.imageGenerationResult,
  });
}

describe('assertBookLayoutQuality', () => {
  it('accepts a complete ordered illustrated book', async () => {
    const candidate = await layout();
    expect(() => assertBookLayoutQuality(candidate, 4)).not.toThrow();
  });

  it('rejects a missing required illustration before PDF rendering', async () => {
    const candidate = await layout();
    delete candidate.entries[1]!.imageBlock;
    expect(() => assertBookLayoutQuality(candidate, 4)).toThrow(BookLayoutQualityError);
  });

  it('rejects unresolved render values', async () => {
    const candidate = await layout();
    candidate.entries[1]!.textBlock!.text = 'undefined';
    expect(() => assertBookLayoutQuality(candidate, 4)).toThrow(/layout_unresolved_value/);
  });
});
