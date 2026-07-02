import type { CharacterCard, GeneratedImageEntry } from '@book/types';
import { generateMockImagePng } from './mock-image-producer';
import type { ImageAssetContentType } from './image-asset-storage';

export interface ImageGenerationInput {
  bookId: string;
  entry: GeneratedImageEntry;
  characterCard: CharacterCard;
}

export interface ImageGenerationOutput {
  buffer: Buffer;
  contentType: ImageAssetContentType;
}

/**
 * Internal boundary for producing the actual image bytes for one generated
 * image entry (cover/page/back_cover). AgentService depends on this
 * interface rather than calling generateMockImagePng directly, so a future
 * real-image provider can implement it and return the same output shape
 * without touching AgentService, ImageAssetStorage, or the PDF renderer.
 */
export interface ImageGenerationProvider {
  /** 'mock' | 'openai' — surfaced only for generation diagnostics, never used for control flow. */
  readonly providerName?: string;
  /** Underlying model identifier, if applicable (mock providers have none). */
  readonly modelName?: string;
  generateImage(input: ImageGenerationInput): Promise<ImageGenerationOutput>;
}

export const IMAGE_GENERATION_PROVIDER_TOKEN = 'IMAGE_GENERATION_PROVIDER';

/**
 * Deterministic local stand-in for a future real-image ImageGenerationProvider.
 * Wraps generateMockImagePng keyed off the entry's own seed — same seed
 * always produces byte-identical PNG bytes, no I/O, no randomness.
 */
export class MockImageGenerationProvider implements ImageGenerationProvider {
  readonly providerName = 'mock' as const;

  async generateImage(input: ImageGenerationInput): Promise<ImageGenerationOutput> {
    return {
      buffer: generateMockImagePng(input.entry.seed),
      contentType: 'image/png',
    };
  }
}
