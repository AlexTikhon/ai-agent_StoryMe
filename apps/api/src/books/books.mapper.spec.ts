import { describe, it, expect, vi, afterEach } from 'vitest';
import type { Book } from '@prisma/client';
import { BookStatus, Pronouns, type ImageGenerationResult } from '@book/types';
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
    childPhotoAssetKey: null,
    childPhotoContentType: null,
    characterProfile: null,
    characterSheetAssetKey: null,
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

const VALID_CHARACTER_PROFILE = {
  childName: 'Mia',
  age: 5,
  visualDescription: 'a cheerful child with a round friendly face',
  faceDescription: 'a round, friendly face with a warm smile',
  hairDescription: 'short wavy brown hair',
  outfitDescription: 'a bright yellow overall with sneakers',
  personalitySummary: 'curious, brave, and kind',
  illustrationStyle: 'warm children book illustration, soft colors, friendly character design',
  consistencyPrompt: "Mia, a stylized 5-year-old children's-book character",
  hasReferencePhoto: false,
  hasCharacterSheet: true,
  schemaVersion: 1 as const,
  canonicalAppearance: {
    age: 5,
    hair: 'short wavy brown hair',
    eyes: 'warm green eyes',
    face: 'round friendly face',
    clothing: 'bright yellow overalls with sneakers',
    artStyle: 'warm storybook illustration',
  },
  characterFingerprint: 'character-fingerprint-v1',
  lockedVisualDescription: 'Mia with short wavy brown hair and yellow overalls',
  negativeConstraints: ['no photorealism', 'no text in image'],
};

const VALID_IMAGE_GENERATION_RESULT: ImageGenerationResult = {
  provider: 'local_mock',
  status: 'complete',
  images: [
    {
      id: 'cover',
      kind: 'cover',
      prompt: 'A safe persisted illustration prompt',
      negativePrompt: 'No text in image.',
      provider: 'local_mock',
      status: 'complete',
      imageUrl: '/mock-images/book-1/cover.svg',
      altText: 'Book cover',
      width: 1024,
      height: 1024,
      seed: 'book-1-cover',
    },
  ],
  createdAt: '2026-08-20T10:00:00.000Z',
  imageByteProvider: 'openai',
  generatedImageCount: 1,
  failedImageCount: 1,
  lastImageError: 'Image generation failed safely.',
  characterReferenceAvailable: true,
  characterReferenceUsedForImages: true,
  imageGenerationMode: 'character-reference-edit',
  characterReferenceLoadError: 'Recorded reference could not be loaded.',
  resume: {
    resumeMode: true,
    requiredAssets: ['character_sheet', 'cover', 'pdf'],
    validExistingAssets: ['character_sheet'],
    missingAssetsBeforeRetry: ['cover'],
    invalidAssetsBeforeRetry: ['pdf'],
    reusedImageCount: 1,
    regeneratedImageCount: 1,
    skippedStoryGeneration: true,
    skippedCharacterProfileGeneration: true,
    skippedCharacterSheetGeneration: true,
    skippedExistingImageGeneration: true,
    missingAssetsAfterRetry: ['pdf'],
    pdfRenderAttempted: true,
    pdfRenderSucceeded: false,
    finalBookStatus: BookStatus.Failed,
  },
  imageFailures: [
    {
      assetLabel: 'cover',
      provider: 'openai',
      model: 'gpt-image-1',
      httpStatus: 429,
      errorType: 'rate_limit_error',
      errorCode: 'rate_limit_exceeded',
      message: 'Rate limit reached.',
      attempts: 2,
      limiterRetries: 1,
      limiterWaitMs: 250,
      characterReferenceSupplied: true,
      requestMode: 'character-reference-edit',
      timeoutMs: 30_000,
      elapsedMs: 30_001,
      retryDecision: 'retry budget exhausted',
    },
  ],
  providerUsage: {
    maxPaidCalls: 12,
    plannedPaidCalls: 5,
    actualPaidCalls: 5,
    estimatedCostUsd: 0.42,
    calls: [
      {
        callIndex: 1,
        operation: 'story_repair',
        provider: 'openai',
        model: 'gpt-4.1-mini',
        promptVersion: 'story-v1-repair-v1',
        promptHash: 'a'.repeat(64),
        attempt: 1,
        durationMs: 123,
        status: 'success',
        estimatedCostUsd: 0.02,
      },
    ],
  },
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
    expect(dto.characterProfile).toBeNull();
  });

  it('passes through a characterProfile that matches the expected shape', () => {
    const book = makeBook({
      characterProfile: VALID_CHARACTER_PROFILE as unknown as Book['characterProfile'],
    });

    const dto = toBookDto(book);

    expect(dto.characterProfile).toEqual(VALID_CHARACTER_PROFILE);
  });

  it('preserves a complete current persisted generation result without semantic loss', () => {
    const book = makeBook({
      characterProfile: VALID_CHARACTER_PROFILE as unknown as Book['characterProfile'],
      imageGenerationResult:
        VALID_IMAGE_GENERATION_RESULT as unknown as Book['imageGenerationResult'],
    });

    const dto = toBookDto(book);

    expect(dto.characterProfile).toEqual(VALID_CHARACTER_PROFILE);
    expect(dto.imageGenerationResult).toEqual(VALID_IMAGE_GENERATION_RESULT);
    expect(dto.imageGenerationResult?.providerUsage?.calls[0]?.operation).toBe('story_repair');
  });

  it('degrades malformed current image-generation JSON to null', () => {
    const book = makeBook({
      imageGenerationResult: {
        ...VALID_IMAGE_GENERATION_RESULT,
        generatedImageCount: -1,
      } as unknown as Book['imageGenerationResult'],
    });

    expect(toBookDto(book).imageGenerationResult).toBeNull();
  });

  it('degrades a malformed characterProfile to null instead of throwing or leaking it', () => {
    const malformed = { childName: 'Mia' } as unknown as Book['characterProfile'];
    const book = makeBook({ characterProfile: malformed });

    const dto = toBookDto(book);

    expect(dto.characterProfile).toBeNull();
  });

  it('passes through a characterCard that matches the expected shape', () => {
    const book = makeBook({
      characterCard: VALID_CHARACTER_CARD as unknown as Book['characterCard'],
    });

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
    const book = makeBook({
      characterCard: ['not', 'an', 'object'] as unknown as Book['characterCard'],
    });

    const dto = toBookDto(book);

    expect(dto.characterCard).toBeNull();
  });
});
