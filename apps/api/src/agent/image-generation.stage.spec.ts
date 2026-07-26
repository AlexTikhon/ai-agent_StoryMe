import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CharacterCard, GeneratedImageEntry } from '@book/types';
import { claimImageAssetKey, type ImageAssetStorage } from '../images/image-asset-storage';
import {
  ImageGenerationBudgetError,
  type ImageGenerationProvider,
  type ImageReference,
} from '../images/image-generation-provider';
import { claimNamespace } from './generation-artifact-namespace';
import { GenerationProviderTelemetry } from './generation-provider-telemetry';
import { ImageGenerationStage, imageAssetLabel } from './image-generation.stage';

const namespace = claimNamespace('run-1', 3);
const characterCard = {
  name: 'Mia',
  age: 7,
  pronouns: 'she/her',
  appearance: {},
  personality: {},
  visualAnchor: 'Mia in a yellow spacesuit',
  narrativeDescription: 'A curious space explorer',
} as unknown as CharacterCard;

function image(
  id: string,
  kind: GeneratedImageEntry['kind'],
  pageNumber?: number,
): GeneratedImageEntry {
  return {
    id,
    kind,
    ...(pageNumber !== undefined && { pageNumber }),
    prompt: `prompt-${id}`,
    negativePrompt: 'unsafe',
    provider: 'local_mock',
    status: 'complete',
    imageUrl: `/mock/${id}`,
    altText: id,
    width: 1024,
    height: 1024,
    seed: `seed-${id}`,
  };
}

function makeStorage() {
  return {
    saveImageAsset: vi.fn().mockImplementation(async (key, _buffer, contentType) => ({
      key,
      path: key,
      contentType,
    })),
  } as unknown as ImageAssetStorage & {
    saveImageAsset: ReturnType<typeof vi.fn>;
  };
}

function makeProvider(
  overrides: Partial<ImageGenerationProvider> = {},
): ImageGenerationProvider & { generateImage: ReturnType<typeof vi.fn> } {
  return {
    providerName: 'mock',
    modelName: 'image-model',
    promptVersion: 'image-test-v1',
    generateCharacterSheet: vi.fn(),
    generateImage: vi.fn().mockImplementation(async ({ entry }) => ({
      buffer: Buffer.from(`bytes-${entry.id}`),
      contentType: 'image/png',
    })),
    ...overrides,
  } as ImageGenerationProvider & { generateImage: ReturnType<typeof vi.fn> };
}

describe('ImageGenerationStage', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('generates and saves every claim-scoped image while sharing one reference', async () => {
    const storage = makeStorage();
    const reference: ImageReference = {
      buffer: Buffer.from('character-sheet'),
      contentType: 'image/png',
    };
    const provider = makeProvider({
      generateImage: vi.fn().mockImplementation(async ({ entry, characterReference }) => ({
        buffer: Buffer.from(`bytes-${entry.id}`),
        contentType: 'image/png',
        usedReference: characterReference === reference,
      })),
    });
    const telemetry = new GenerationProviderTelemetry(10, 0);
    const images = [image('cover', 'cover'), image('page-1', 'page', 1)];
    const stage = new ImageGenerationStage(storage, provider);

    const result = await stage.execute({
      bookId: 'book-1',
      characterCard,
      images,
      characterReference: reference,
      namespace,
      telemetry,
    });

    expect(stage.step).toBe('image_gen');
    expect(result).toEqual({
      generatedCount: 2,
      failedCount: 0,
      usedCharacterReference: true,
      failures: [],
    });
    expect(provider.generateImage).toHaveBeenCalledTimes(2);
    for (const [input] of provider.generateImage.mock.calls) {
      expect(input.characterReference).toBe(reference);
    }
    expect(storage.saveImageAsset).toHaveBeenCalledWith(
      claimImageAssetKey('book-1', namespace, 'cover'),
      Buffer.from('bytes-cover'),
      'image/png',
    );
    expect(storage.saveImageAsset).toHaveBeenCalledWith(
      claimImageAssetKey('book-1', namespace, 'page', 1),
      Buffer.from('bytes-page-1'),
      'image/png',
    );
    expect(telemetry.snapshot().calls.map((call) => call.assetLabel)).toEqual(['cover', 'page_1']);
  });

  it('continues the batch and exposes safe structured diagnostics for one failed entry', async () => {
    const storage = makeStorage();
    const failure = Object.assign(new Error('provider rejected image'), {
      details: {
        httpStatus: 429,
        errorType: 'rate_limit_error',
        errorCode: 'rate_limited',
        attempts: 3,
        limiterRetries: 2,
        limiterWaitMs: 1250,
        retryDecision: 'retry budget exhausted',
      },
    });
    const provider = makeProvider({
      providerName: 'openai',
      generateImage: vi.fn().mockImplementation(async ({ entry }) => {
        if (entry.kind === 'cover') throw failure;
        return {
          buffer: Buffer.from(`bytes-${entry.id}`),
          contentType: 'image/png',
        };
      }),
    });
    const images = [image('cover', 'cover'), image('page-1', 'page', 1)];
    const stage = new ImageGenerationStage(storage, provider);

    const result = await stage.execute({
      bookId: 'book-1',
      characterCard,
      images,
      namespace,
      telemetry: new GenerationProviderTelemetry(10, 2),
    });

    expect(result.generatedCount).toBe(1);
    expect(result.failedCount).toBe(1);
    expect(result.lastError).toBe('provider rejected image');
    expect(result.failures).toEqual([
      expect.objectContaining({
        assetLabel: 'cover',
        provider: 'openai',
        model: 'image-model',
        httpStatus: 429,
        errorType: 'rate_limit_error',
        errorCode: 'rate_limited',
        attempts: 3,
        limiterRetries: 2,
        limiterWaitMs: 1250,
        characterReferenceSupplied: false,
        requestMode: 'text-to-image',
        retryDecision: 'retry budget exhausted',
      }),
    ]);
    expect(storage.saveImageAsset).toHaveBeenCalledTimes(1);
  });

  it('counts a storage failure per entry without discarding successful siblings', async () => {
    const storage = makeStorage();
    storage.saveImageAsset.mockImplementation(async (key, _buffer, contentType) => {
      if (key.endsWith('/cover')) throw new Error('disk full');
      return { key, path: key, contentType };
    });
    const stage = new ImageGenerationStage(storage, makeProvider());

    const result = await stage.execute({
      bookId: 'book-1',
      characterCard,
      images: [image('cover', 'cover'), image('page-1', 'page', 1)],
      namespace,
      telemetry: new GenerationProviderTelemetry(10, 0),
    });

    expect(result.generatedCount).toBe(1);
    expect(result.failedCount).toBe(1);
    expect(result.failures[0]).toEqual(
      expect.objectContaining({
        assetLabel: 'cover',
        message: 'disk full',
        attempts: 1,
      }),
    );
  });

  it('rejects an undersized real-provider budget before starting any paid call', async () => {
    vi.stubEnv('MAX_GENERATED_IMAGES_PER_BOOK', '1');
    const provider = makeProvider({ providerName: 'openai' });
    const storage = makeStorage();
    const stage = new ImageGenerationStage(storage, provider);

    await expect(
      stage.execute({
        bookId: 'book-1',
        characterCard,
        images: [image('cover', 'cover'), image('page-1', 'page', 1)],
        namespace,
        telemetry: new GenerationProviderTelemetry(10, 2),
      }),
    ).rejects.toBeInstanceOf(ImageGenerationBudgetError);

    expect(provider.generateImage).not.toHaveBeenCalled();
    expect(storage.saveImageAsset).not.toHaveBeenCalled();
  });

  it('keeps stable diagnostic labels for cover, pages, and back cover', () => {
    expect(imageAssetLabel(image('cover', 'cover'))).toBe('cover');
    expect(imageAssetLabel(image('page-4', 'page', 4))).toBe('page_4');
    expect(imageAssetLabel(image('back', 'back_cover'))).toBe('back_cover');
  });
});
