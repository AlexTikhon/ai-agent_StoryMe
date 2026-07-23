import { AgentStep } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import { MockCharacterProfileProvider } from './character-profile-provider';
import { MockStoryGenerationProvider } from './story-generation-provider';
import { BookLayoutStage } from './book-layout.stage';

async function makeInput() {
  const characterProfile = await new MockCharacterProfileProvider().buildProfile({
    bookId: 'book-1',
    childName: 'Mia',
    childAge: 5,
    theme: 'friendship',
    language: 'en',
  });
  const result = await new MockStoryGenerationProvider().generateStory({
    bookId: 'book-1',
    childName: 'Mia',
    childAge: 5,
    theme: 'friendship',
    language: 'en',
    pageCount: 4,
    characterProfile,
  });
  return {
    bookId: 'book-1',
    bookPreview: result.bookPreview,
    imageGenerationResult: result.imageGenerationResult,
  };
}

describe('BookLayoutStage', () => {
  it('exposes the layout orchestration step', () => {
    expect(new BookLayoutStage().step).toBe(AgentStep.layout);
  });

  it('preserves the cover, ordered page and back-cover layout contract', async () => {
    const layout = new BookLayoutStage().execute(await makeInput());

    expect(layout.status).toBe('complete');
    expect(layout.metadata).toEqual({
      title: expect.any(String),
      childName: 'Mia',
      totalPages: 4,
      generatedAt: '1970-01-01T00:00:00.000Z',
    });
    expect(
      layout.entries.map(({ kind, pageNumber, template }) => ({ kind, pageNumber, template })),
    ).toEqual([
      { kind: 'cover', pageNumber: undefined, template: 'cover_full_bleed' },
      { kind: 'page', pageNumber: 1, template: 'image_top_text_bottom' },
      { kind: 'page', pageNumber: 2, template: 'image_top_text_bottom' },
      { kind: 'page', pageNumber: 3, template: 'image_top_text_bottom' },
      { kind: 'page', pageNumber: 4, template: 'image_top_text_bottom' },
      { kind: 'back_cover', pageNumber: undefined, template: 'back_cover_summary' },
    ]);
    expect(layout.entries.every((entry) => entry.imageBlock != null)).toBe(true);
  });

  it('keeps the existing text-only fallback when a page has no planned image', async () => {
    const input = await makeInput();
    input.imageGenerationResult.images = input.imageGenerationResult.images.filter(
      (image) => image.kind !== 'page' || image.pageNumber !== 2,
    );

    const layout = new BookLayoutStage().execute(input);
    const page = layout.entries.find((entry) => entry.kind === 'page' && entry.pageNumber === 2);

    expect(page).toMatchObject({
      template: 'text_only',
      textBlock: {
        box: { x: 180, y: 180, width: 2040, height: 2040 },
        fontSize: 20,
      },
    });
    expect(page).not.toHaveProperty('imageBlock');
  });
});
