import type { CharacterCard, CharacterProfile, GeneratedImageEntry } from '@book/types';
import { generateMockImagePng } from './mock-image-producer';
import type { ImageAssetContentType } from './image-asset-storage';

/**
 * A generated, stylized character-sheet reference image (never the original
 * uploaded child photo — see AgentService.startBookGeneration) passed to
 * generateImage so a real provider can visually anchor the scene to the same
 * character instead of relying on text description alone.
 */
export interface ImageReference {
  buffer: Buffer;
  contentType: ImageAssetContentType;
  filename?: string;
}

export interface ImageGenerationInput {
  bookId: string;
  entry: GeneratedImageEntry;
  characterCard: CharacterCard;
  /** Optional visual anchor for this entry's illustration; see {@link ImageReference}. Absent for the mock provider and for books with no character sheet. */
  characterReference?: ImageReference;
}

export interface ImageGenerationOutput {
  buffer: Buffer;
  contentType: ImageAssetContentType;
  /** True when this output was actually produced via a visual character-reference request (not just that a reference was available). Undefined/false otherwise. */
  usedReference?: boolean;
}

/** Input for generating a book's character-sheet reference image — not a GeneratedImageEntry, since it's never rendered as its own PDF page. */
export interface CharacterSheetInput {
  bookId: string;
  characterProfile: CharacterProfile;
}

/**
 * Internal boundary for producing the actual image bytes for one generated
 * image entry (cover/page/back_cover), and for the standalone character-sheet
 * reference image. AgentService depends on this interface rather than
 * calling generateMockImagePng directly, so a future real-image provider can
 * implement it and return the same output shape without touching
 * AgentService, ImageAssetStorage, or the PDF renderer.
 */
export interface ImageGenerationProvider {
  /** 'mock' | 'openai' — surfaced only for generation diagnostics, never used for control flow. */
  readonly providerName?: string;
  /** Underlying model identifier, if applicable (mock providers have none). */
  readonly modelName?: string;
  generateImage(input: ImageGenerationInput): Promise<ImageGenerationOutput>;
  generateCharacterSheet(input: CharacterSheetInput): Promise<ImageGenerationOutput>;
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

  async generateCharacterSheet(input: CharacterSheetInput): Promise<ImageGenerationOutput> {
    return {
      buffer: generateMockImagePng(`${input.bookId}:character_sheet:0`),
      contentType: 'image/png',
    };
  }
}

const DEFAULT_MAX_GENERATED_IMAGES_PER_BOOK = 3;

/**
 * Cost guardrail for real (paid) image generation: caps how many of a book's
 * image entries (cover/pages/back_cover, taken in their existing order)
 * AgentService.generateAndSaveImageAssets actually sends to the real
 * ImageGenerationProvider. Entries beyond the cap are skipped before any API
 * call is made and fall back to the existing placeholder-rectangle rendering
 * — the same fallback any entry ImageAssetStorage has no bytes for already
 * gets (see buildImageBufferResolver in image-asset-storage.ts). Only applies
 * when the real provider is selected; MockImageGenerationProvider is free, so
 * AgentService never caps it.
 */
export function resolveMaxGeneratedImagesPerBook(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env['MAX_GENERATED_IMAGES_PER_BOOK'];
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_MAX_GENERATED_IMAGES_PER_BOOK;
}
