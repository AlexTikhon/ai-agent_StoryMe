import { describe, it, expect, vi, afterEach } from 'vitest';
import type { Book } from '@prisma/client';
import { Pronouns } from '@book/types';
import { toBookDto } from './books.mapper';

const STATUS_CREATED = 'created' as Book['status'];

function makeBook(overrides: Partial<Book> = {}): Book {
  return {
    id: 'b-1',
    userId: 'u-1',
    childProfileId: null,
    status: STATUS_CREATED,
    request: null,
    title: 'The Adventures of Mia',
    dedicationText: null,
    pageCount: null,
    childName: 'Mia',
    childAge: 5,
    language: 'en' as Book['language'],
    theme: 'friendship',
    educationalMessage: null,
    characterCard: null,
    storyPlan: null,
    bookPreview: null,
    imageGenerationResult: null,
    bookLayout: null,
    chapters: null,
    imagePrompts: null,
    qualityReport: null,
    pageLayouts: null,
    coverUrl: null,
    pdfR2Key: null,
    pdfUrl: null,
    printPdfR2Key: null,
    printPdfUrl: null,
    previewPdfR2Key: null,
    previewPdfUrl: null,
    socialCardUrl: null,
    isPaid: false,
    paidAt: null,
    stripePaymentIntentId: null,
    isPublic: false,
    generationTimeMs: null,
    totalCostUsd: null,
    aiModelVersions: null,
    generatedDegraded: false,
    errorMessage: null,
    retryCount: 0,
    failedStep: null,
    deletedAt: null,
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
    ...overrides,
  } as Book;
}

const VALID_CHARACTER_CARD = {
  name: 'Mia',
  age: 5,
  pronouns: Pronouns.SheHer,
  appearance: {
    hairColor: 'brown',
    hairStyle: 'curly',
    eyeColor: 'green',
    skinTone: 'tan',
    distinctiveFeatures: [],
  },
  personality: {
    traits: ['brave'],
    favoriteAnimals: ['fox'],
    favoriteColors: ['blue'],
    favoriteToys: ['kite'],
    hobbies: ['drawing'],
  },
  visualAnchor: 'A brave 5-year-old girl with curly brown hair',
  narrativeDescription: 'Mia loves adventures.',
};

describe('toBookDto', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('maps null Json columns to null', () => {
    const dto = toBookDto(makeBook());

    expect(dto.characterCard).toBeNull();
    expect(dto.storyPlan).toBeNull();
    expect(dto.bookPreview).toBeNull();
    expect(dto.imageGenerationResult).toBeNull();
    expect(dto.bookLayout).toBeNull();
  });

  it('passes through a characterCard that matches the expected shape', () => {
    const book = makeBook({ characterCard: VALID_CHARACTER_CARD as unknown as Book['characterCard'] });

    const dto = toBookDto(book);

    expect(dto.characterCard).toEqual(VALID_CHARACTER_CARD);
  });

  it('degrades a malformed characterCard to null instead of throwing or leaking it', () => {
    const malformed = { name: 'Mia' } as unknown as Book['characterCard'];
    const book = makeBook({ characterCard: malformed });

    const dto = toBookDto(book);

    expect(dto.characterCard).toBeNull();
  });

  it('degrades a characterCard with the wrong shape entirely (e.g. an array) to null', () => {
    const book = makeBook({ characterCard: ['not', 'an', 'object'] as unknown as Book['characterCard'] });

    const dto = toBookDto(book);

    expect(dto.characterCard).toBeNull();
  });
});
