import { describe, it, expect } from 'vitest';
import {
  MockImageGenerationProvider,
  resolveMaxIllustrationsPerBook,
  type ImageGenerationInput,
} from './image-generation-provider';
import { Pronouns, type CharacterCard, type GeneratedImageEntry } from '@book/types';

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
});

describe('resolveMaxIllustrationsPerBook', () => {
  it('defaults to 3 when unset', () => {
    expect(resolveMaxIllustrationsPerBook({} as NodeJS.ProcessEnv)).toBe(3);
  });

  it('defaults to 3 when empty', () => {
    expect(
      resolveMaxIllustrationsPerBook({
        MAX_ILLUSTRATIONS_PER_BOOK: '',
      } as unknown as NodeJS.ProcessEnv),
    ).toBe(3);
  });

  it('parses a valid positive integer from env', () => {
    expect(
      resolveMaxIllustrationsPerBook({
        MAX_ILLUSTRATIONS_PER_BOOK: '5',
      } as unknown as NodeJS.ProcessEnv),
    ).toBe(5);
  });

  it('floors a non-integer value', () => {
    expect(
      resolveMaxIllustrationsPerBook({
        MAX_ILLUSTRATIONS_PER_BOOK: '4.9',
      } as unknown as NodeJS.ProcessEnv),
    ).toBe(4);
  });

  it('falls back to the default for zero, negative, or non-numeric values', () => {
    expect(
      resolveMaxIllustrationsPerBook({
        MAX_ILLUSTRATIONS_PER_BOOK: '0',
      } as unknown as NodeJS.ProcessEnv),
    ).toBe(3);
    expect(
      resolveMaxIllustrationsPerBook({
        MAX_ILLUSTRATIONS_PER_BOOK: '-2',
      } as unknown as NodeJS.ProcessEnv),
    ).toBe(3);
    expect(
      resolveMaxIllustrationsPerBook({
        MAX_ILLUSTRATIONS_PER_BOOK: 'not-a-number',
      } as unknown as NodeJS.ProcessEnv),
    ).toBe(3);
  });
});
