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

/**
 * Safe, non-secret structured failure details a provider MAY attach to a
 * thrown Error via a `details` property (see OpenAIImageRequestError in
 * openai-image-generation-provider.ts) so AgentService can build a truthful
 * ImageGenerationFailureDetail without depending on any specific provider's
 * error classes. Never includes the API key, image bytes/base64, or a raw
 * provider response body.
 */
export interface ImageGenerationFailureDetails {
  httpStatus?: number;
  errorType?: string;
  errorCode?: string;
  attempts?: number;
  limiterRetries?: number;
  limiterWaitMs?: number;
  /** Whether a character-sheet reference was actually attached to the request that failed. */
  characterReferenceSupplied?: boolean;
  /** Which endpoint shape the failed request actually used. */
  requestMode?: 'text-to-image' | 'character-reference-edit';
  /** Configured per-attempt HTTP timeout (ms) for the failed request. Only set when the failure was a request timeout (errorCode === 'request_timeout'). */
  timeoutMs?: number;
  /**
   * Wall-clock ms spent actually attempting the HTTP request(s) (including
   * any internal timeout retries), measured from when the request left the
   * rate-limiter's spacing queue — never includes limiterWaitMs. Only set
   * when the failure was a request timeout. Whether the multipart upload
   * itself had finished before the abort fired is not observable through the
   * native fetch/FormData API, so it is deliberately not reported rather than
   * guessed.
   */
  elapsedMs?: number;
  /** Why no further timeout retry was attempted. Only set when the failure was a request timeout. */
  retryDecision?: string;
}

interface ImageGenerationFailureError extends Error {
  details: ImageGenerationFailureDetails;
}

/** Duck-types `err` to check whether it carries a `details` object (see ImageGenerationFailureDetails) instead of importing any specific provider's error class. */
export function hasImageGenerationFailureDetails(err: unknown): err is ImageGenerationFailureError {
  return (
    err instanceof Error &&
    'details' in err &&
    typeof (err as { details?: unknown }).details === 'object' &&
    (err as { details?: unknown }).details !== null
  );
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
  /** Safe (no secrets/prompts/bytes) rate-limiter diagnostics snapshot, if this provider is rate-limited. Only OpenAIImageGenerationProvider implements this. */
  getRateLimitDiagnostics?(): {
    requestsQueued: number;
    totalWaitMs: number;
    rateLimitHits: number;
    retriesUsed: number;
    retryAfterHonoredCount: number;
  };
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
