import { describe, it, expect } from 'vitest';
import {
  assertCompleteBookImageBudget,
  ImageGenerationBudgetError,
  MockImageGenerationProvider,
  requiredGeneratedImagesForBook,
  resolveMaxGeneratedImagesPerBook,
  type ImageGenerationInput,
  type ImageReference,
} from './image-generation-provider';
import {
  Pronouns,
  type CharacterCard,
  type CharacterProfile,
  type GeneratedImageEntry,
} from '@book/types';

function makeCharacterProfile(overrides: Partial<CharacterProfile> = {}): CharacterProfile {
  return {
    childName: 'Mia',
    age: 5,
    visualDescription: 'a cheerful child with a round friendly face',
    faceDescription: 'a round, friendly face with a warm smile',
    hairDescription: 'short wavy brown hair',
    outfitDescription: 'a bright yellow overall with sneakers',
    personalitySummary: 'curious, brave, and kind',
    illustrationStyle: 'warm children book illustration, soft colors, friendly character design',
    consistencyPrompt:
      "Mia, a stylized 5-year-old children's-book character with a round, friendly face with a warm smile, short wavy brown hair, wearing a bright yellow overall with sneakers",
    hasReferencePhoto: false,
    hasCharacterSheet: false,
    ...overrides,
  };
}

function makeCharacterCard(overrides: Partial<CharacterCard> = {}): CharacterCard {
  return {
    name: 'Mia',
    age: 5,
    pronouns: Pronouns.SheHer,
    appearance: {
      hairColor: 'brown',
      hairStyle: 'wavy',
      eyeColor: 'brown',
      skinTone: 'medium',
      distinctiveFeatures: ['bright smile'],
    },
    personality: {
      traits: ['curious'],
      favoriteAnimals: ['rabbit'],
      favoriteColors: ['purple'],
      favoriteToys: ['blocks'],
      hobbies: ['drawing'],
    },
    visualAnchor: 'A 5-year-old child named Mia with wavy brown hair',
    narrativeDescription: 'Mia is curious and brave.',
    ...overrides,
  };
}

function makeEntry(overrides: Partial<GeneratedImageEntry> = {}): GeneratedImageEntry {
  return {
    id: 'b-1-cover',
    kind: 'cover',
    prompt: 'Mia standing in a garden',
    provider: 'local_mock',
    status: 'complete',
    imageUrl: '/mock-images/b-1/cover.svg',
    altText: 'Cover illustration',
    width: 768,
    height: 1024,
    seed: 'b-1:cover:0',
    ...overrides,
  };
}

function makeInput(overrides: Partial<ImageGenerationInput> = {}): ImageGenerationInput {
  return {
    bookId: 'b-1',
    entry: makeEntry(),
    characterCard: makeCharacterCard(),
    ...overrides,
  };
}

describe('MockImageGenerationProvider', () => {
  it('returns a PNG buffer and contentType', async () => {
    const provider = new MockImageGenerationProvider();
    const result = await provider.generateImage(makeInput());

    expect(Buffer.isBuffer(result.buffer)).toBe(true);
    expect(result.buffer.length).toBeGreaterThan(0);
    expect(result.contentType).toBe('image/png');
  });

  it('produces byte-identical output for the same entry seed (deterministic)', async () => {
    const provider = new MockImageGenerationProvider();
    const first = await provider.generateImage(makeInput());
    const second = await provider.generateImage(makeInput());

    expect(first.buffer.equals(second.buffer)).toBe(true);
  });

  it('produces different output for a different seed', async () => {
    const provider = new MockImageGenerationProvider();
    const cover = await provider.generateImage(
      makeInput({ entry: makeEntry({ seed: 'b-1:cover:0' }) }),
    );
    const page = await provider.generateImage(
      makeInput({ entry: makeEntry({ seed: 'b-1:page:1' }) }),
    );

    expect(cover.buffer.equals(page.buffer)).toBe(false);
  });

  it('ignores an attached characterReference and never sets usedReference (mock stays free/text-only)', async () => {
    const provider = new MockImageGenerationProvider();
    const characterReference: ImageReference = {
      buffer: Buffer.from('fake-character-sheet'),
      contentType: 'image/png',
    };

    const result = await provider.generateImage(makeInput({ characterReference }));

    expect(Buffer.isBuffer(result.buffer)).toBe(true);
    expect(result.usedReference).toBeUndefined();
  });

  it('never waits on any rate limiter (no getRateLimitDiagnostics, resolves without delay)', async () => {
    const provider = new MockImageGenerationProvider();
    expect(provider.getRateLimitDiagnostics).toBeUndefined();

    const startedAt = Date.now();
    await provider.generateImage(makeInput());
    await provider.generateImage(makeInput());
    await provider.generateImage(makeInput());
    expect(Date.now() - startedAt).toBeLessThan(50);
  });

  describe('generateCharacterSheet', () => {
    it('returns a PNG buffer and contentType', async () => {
      const provider = new MockImageGenerationProvider();
      const result = await provider.generateCharacterSheet({
        bookId: 'b-1',
        characterProfile: makeCharacterProfile(),
      });

      expect(Buffer.isBuffer(result.buffer)).toBe(true);
      expect(result.buffer.length).toBeGreaterThan(0);
      expect(result.contentType).toBe('image/png');
    });

    it('is deterministic per bookId and differs from a page/cover image for the same book', async () => {
      const provider = new MockImageGenerationProvider();
      const first = await provider.generateCharacterSheet({
        bookId: 'b-1',
        characterProfile: makeCharacterProfile(),
      });
      const second = await provider.generateCharacterSheet({
        bookId: 'b-1',
        characterProfile: makeCharacterProfile(),
      });
      const cover = await provider.generateImage(makeInput());

      expect(first.buffer.equals(second.buffer)).toBe(true);
      expect(first.buffer.equals(cover.buffer)).toBe(false);
    });
  });
});

describe('resolveMaxGeneratedImagesPerBook', () => {
  it('defaults to 14 when unset so a maximum-length book can complete', () => {
    expect(resolveMaxGeneratedImagesPerBook({} as NodeJS.ProcessEnv)).toBe(14);
  });

  it('defaults to 14 when empty', () => {
    expect(
      resolveMaxGeneratedImagesPerBook({
        MAX_GENERATED_IMAGES_PER_BOOK: '',
      } as unknown as NodeJS.ProcessEnv),
    ).toBe(14);
  });

  it('parses a valid positive integer from env', () => {
    expect(
      resolveMaxGeneratedImagesPerBook({
        MAX_GENERATED_IMAGES_PER_BOOK: '5',
      } as unknown as NodeJS.ProcessEnv),
    ).toBe(5);
  });

  it('floors a non-integer value', () => {
    expect(
      resolveMaxGeneratedImagesPerBook({
        MAX_GENERATED_IMAGES_PER_BOOK: '4.9',
      } as unknown as NodeJS.ProcessEnv),
    ).toBe(4);
  });

  it('falls back to the default for zero, negative, or non-numeric values', () => {
    expect(
      resolveMaxGeneratedImagesPerBook({
        MAX_GENERATED_IMAGES_PER_BOOK: '0',
      } as unknown as NodeJS.ProcessEnv),
    ).toBe(14);
    expect(
      resolveMaxGeneratedImagesPerBook({
        MAX_GENERATED_IMAGES_PER_BOOK: '-2',
      } as unknown as NodeJS.ProcessEnv),
    ).toBe(14);
    expect(
      resolveMaxGeneratedImagesPerBook({
        MAX_GENERATED_IMAGES_PER_BOOK: 'not-a-number',
      } as unknown as NodeJS.ProcessEnv),
    ).toBe(14);
  });
});

describe('complete-book image budget', () => {
  it('requires one image per story page plus cover and back cover', () => {
    expect(requiredGeneratedImagesForBook(6)).toBe(8);
    expect(requiredGeneratedImagesForBook(12)).toBe(14);
  });

  it('uses the product default page count when the snapshot has no explicit page count', () => {
    expect(requiredGeneratedImagesForBook(null)).toBe(8);
    expect(requiredGeneratedImagesForBook(undefined)).toBe(8);
  });

  it('rejects the whole budget instead of allowing partial paid generation', () => {
    expect(() => assertCompleteBookImageBudget(8, 7)).toThrow(ImageGenerationBudgetError);
    expect(() => assertCompleteBookImageBudget(8, 8)).not.toThrow();
  });
});
