import { Logger } from '@nestjs/common';
import type { CharacterCard, CharacterProfile, GeneratedImageEntry } from '@book/types';
import type {
  CharacterSheetInput,
  ImageGenerationFailureDetails,
  ImageGenerationInput,
  ImageGenerationOutput,
  ImageGenerationProvider,
  ImageReference,
} from './image-generation-provider';
import {
  DEFAULT_OPENAI_MAX_RETRIES,
  DEFAULT_OPENAI_REQUEST_TIMEOUT_MS,
  fetchWithRetry,
  OpenAIRequestError,
} from '../common/openai-request';
import {
  OpenAIImageRateLimiter,
  type OpenAIImageRateLimiterDiagnostics,
} from './openai-image-rate-limiter';

const DEFAULT_MODEL = 'gpt-image-1';
const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_SIZE = '1024x1024';
const DEFAULT_MAX_PAGES = 12;

/**
 * 429 is deliberately excluded here: fetchWithRetry only retries the other
 * transient statuses (network blips / 5xx) with its own small fixed backoff.
 * 429 is returned on the first attempt and handled exclusively by the shared
 * OpenAIImageRateLimiter, which coordinates spacing/backoff/Retry-After
 * across every concurrent image request instead of retrying in isolation.
 */
const IMAGE_RETRYABLE_STATUS_CODES = new Set([408, 500, 502, 503, 504]);

export class ImageGenerationProviderError extends Error {
  constructor(
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'ImageGenerationProviderError';
  }
}

/**
 * Thrown by every failure path in OpenAIImageGenerationProvider's request
 * flow (network/timeout, non-2xx HTTP response, or a malformed 2xx body) so
 * AgentService can build a truthful ImageGenerationFailureDetail for
 * diagnostics without ever needing the raw response body, image bytes, or
 * API key (see ImageGenerationFailureDetails and hasImageGenerationFailureDetails
 * in image-generation-provider.ts).
 */
export class OpenAIImageRequestError extends ImageGenerationProviderError {
  constructor(
    message: string,
    readonly details: ImageGenerationFailureDetails,
    cause?: unknown,
  ) {
    super(message, cause);
    this.name = 'OpenAIImageRequestError';
  }
}

/**
 * Best-effort, safe extraction of `error.message`/`error.type`/`error.code`
 * from an OpenAI JSON error body (`{ "error": { "message", "type", "code" } }`).
 * Never falls back to including the raw body text — an unparseable body could
 * in principle be a non-JSON dump, so a generic message is used instead.
 */
function parseOpenAIErrorBody(bodyText: string): {
  message?: string;
  type?: string;
  code?: string;
} {
  try {
    const parsed = JSON.parse(bodyText) as {
      error?: { message?: unknown; type?: unknown; code?: unknown };
    };
    const error = parsed?.error;
    if (!error || typeof error !== 'object') return {};
    return {
      ...(typeof error.message === 'string' && { message: error.message.slice(0, 500) }),
      ...(typeof error.type === 'string' && { type: error.type }),
      ...(typeof error.code === 'string' && { code: error.code }),
    };
  } catch {
    return {};
  }
}

/**
 * Builds a focused, deterministic image prompt for one story page/cover
 * entry: child-safe personalized storybook illustration style, the page's
 * own scene, and character info from characterCard so the protagonist stays
 * visually consistent across every illustration, ending with an explicit
 * no-text/no-watermark instruction.
 */
export function buildImagePrompt(
  characterCard: Pick<CharacterCard, 'visualAnchor' | 'narrativeDescription'>,
  entry: Pick<GeneratedImageEntry, 'prompt'>,
): string {
  return [
    "Personalized children's storybook illustration, warm and child-safe, soft colors, friendly character design.",
    `Protagonist: ${characterCard.visualAnchor}. ${characterCard.narrativeDescription}`,
    `Scene: ${entry.prompt}`,
    "The illustration must clearly depict: the environment/setting, the specific action the character is doing, the character's emotion/expression, and warm, storybook-appropriate lighting and composition (clear focal point, not cluttered).",
    "Do not change the character's age, face shape, hairstyle, or outfit from the description above — keep the protagonist visually identical across every illustration in this book.",
    'No text, no letters, no captions, no watermarks, no logos.',
  ].join(' ');
}

/**
 * Builds the image prompt used when a character-sheet reference image is
 * attached to the request (the OpenAI `/images/edits` path — see
 * requestImageEdit). Distinguishes visual identity that must be copied
 * unchanged from the attached reference sheet (age, face shape, hairstyle,
 * hair color, eyes, outfit, proportions, illustration style) from scene
 * content that must come from this entry's own prompt (environment, action,
 * emotion, lighting, framing, composition) — pose and expression are
 * expected to change per scene, so this deliberately does not repeat
 * buildImagePrompt's "keep ... identical" framing, which would contradict
 * that.
 */
export function buildReferenceImagePrompt(
  characterCard: Pick<CharacterCard, 'visualAnchor' | 'narrativeDescription'>,
  entry: Pick<GeneratedImageEntry, 'prompt'>,
): string {
  return [
    "Personalized children's storybook illustration, warm and child-safe, soft colors, friendly character design.",
    'Use the attached character reference sheet as the authoritative visual reference for the protagonist.',
    `Protagonist: ${characterCard.visualAnchor}. ${characterCard.narrativeDescription}`,
    'Preserve the exact same child character shown in the reference sheet: the same approximate age, face shape, hairstyle, hair color, eye appearance, outfit, proportions, and illustration style. Do not redraw or reproduce the reference sheet itself — place this character naturally into the new scene described below.',
    `Scene: ${entry.prompt}`,
    "The illustration must clearly depict: the environment/setting, the specific action the character is doing, the character's emotion/expression, and warm, storybook-appropriate lighting and composition (clear focal point, not cluttered).",
    'Pose and facial expression should change naturally to fit this scene — do not force the exact same pose or expression as the reference sheet.',
    'Depict only one copy of the protagonist in the scene — never a second copy of the character.',
    'Do not include any reference-sheet layout, turnaround/multi-pose grid, labels, captions, borders, text, or watermarks in the output — this must look like a single ordinary storybook illustration, not a character sheet.',
  ].join(' ');
}

/**
 * Builds the prompt for a book's standalone character-sheet reference image:
 * full-body front view, the exact outfit to reuse throughout the book, a
 * clean plain background, and an explicit stylized/non-photorealistic
 * instruction — this is the one illustration meant purely as a consistency
 * aid, never printed as its own PDF page.
 */
export function buildCharacterSheetPrompt(characterProfile: CharacterProfile): string {
  return [
    "Full-body, front-view children's book character reference sheet.",
    `Character: ${characterProfile.consistencyPrompt}.`,
    `Outfit: ${characterProfile.outfitDescription}. This exact outfit must be used consistently throughout the entire book.`,
    `Illustration style: ${characterProfile.illustrationStyle}.`,
    'Clean plain background, neutral even lighting, character centered and fully visible head to toe.',
    'This is a stylized, warm, child-safe illustrated caricature — not a realistic photographic portrait.',
    'No text, no captions, no letters, no watermarks, no logos.',
  ].join(' ');
}

const CHARACTER_SHEET_SIZE = '1024x1536';

function sizeForEntry(entry: Pick<GeneratedImageEntry, 'width' | 'height'>): string {
  if (entry.width > entry.height) return '1536x1024';
  if (entry.height > entry.width) return '1024x1536';
  return DEFAULT_SIZE;
}

export interface OpenAIImageGenerationProviderOptions {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxRetries?: number;
  /** Caps real (paid) image generation to this many story pages. See REAL_GENERATION_MAX_PAGES. */
  maxPages?: number;
  /**
   * Shared rate limiter every request from this provider instance is
   * scheduled through (see OpenAIImageRateLimiter). Defaults to a
   * minIntervalMs=0 instance — i.e. no artificial spacing — so constructing
   * a provider directly (as most unit tests do) behaves exactly as before;
   * the real process-wide, env-configured limiter is injected explicitly by
   * image-generation-provider.factory.ts for the actual openai provider path.
   */
  rateLimiter?: OpenAIImageRateLimiter;
}

/**
 * Real image-generation ImageGenerationProvider. Calls the OpenAI images API
 * for one base64-encoded PNG per page/cover entry and maps it into the exact
 * ImageGenerationOutput shape MockImageGenerationProvider returns —
 * AgentService and everything downstream (ImageAssetStorage, PDF renderer)
 * never see raw API response shapes. Selected via
 * createImageGenerationProvider (image-generation-provider.factory.ts);
 * never constructed unless IMAGE_GENERATION_PROVIDER=openai is
 * explicitly set.
 */
export class OpenAIImageGenerationProvider implements ImageGenerationProvider {
  readonly providerName = 'openai' as const;
  private readonly logger = new Logger(OpenAIImageGenerationProvider.name);
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly maxPages: number;
  private readonly rateLimiter: OpenAIImageRateLimiter;

  constructor(options: OpenAIImageGenerationProviderOptions) {
    if (!options.apiKey) {
      throw new ImageGenerationProviderError('OpenAIImageGenerationProvider requires an apiKey');
    }
    this.apiKey = options.apiKey;
    this.model = options.model ?? DEFAULT_MODEL;
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_OPENAI_REQUEST_TIMEOUT_MS;
    this.maxRetries = options.maxRetries ?? DEFAULT_OPENAI_MAX_RETRIES;
    this.maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
    this.rateLimiter = options.rateLimiter ?? new OpenAIImageRateLimiter({ minIntervalMs: 0 });
  }

  get modelName(): string {
    return this.model;
  }

  /** Safe (no secrets/prompts/bytes) snapshot of this provider's shared rate limiter — see AgentService's image-generation log line. */
  getRateLimitDiagnostics(): OpenAIImageRateLimiterDiagnostics {
    return this.rateLimiter.getDiagnostics();
  }

  async generateImage(input: ImageGenerationInput): Promise<ImageGenerationOutput> {
    if (
      input.entry.kind === 'page' &&
      typeof input.entry.pageNumber === 'number' &&
      input.entry.pageNumber > this.maxPages
    ) {
      throw new ImageGenerationProviderError(
        `Refusing to generate image for page ${input.entry.pageNumber}: exceeds REAL_GENERATION_MAX_PAGES limit of ${this.maxPages}`,
      );
    }

    const size = sizeForEntry(input.entry);
    if (input.characterReference) {
      const prompt = buildReferenceImagePrompt(input.characterCard, input.entry);
      return this.requestImageEdit(
        prompt,
        size,
        input.characterReference,
        'Image generation (character reference)',
      );
    }

    const prompt = buildImagePrompt(input.characterCard, input.entry);
    return this.requestImage(prompt, size, 'Image generation');
  }

  async generateCharacterSheet(input: CharacterSheetInput): Promise<ImageGenerationOutput> {
    const prompt = buildCharacterSheetPrompt(input.characterProfile);
    return this.requestImage(prompt, CHARACTER_SHEET_SIZE, 'Character sheet generation');
  }

  /** gpt-image-1 (the default model) supports the `input_fidelity` edit parameter; a future non-gpt-image model may not. */
  private supportsInputFidelity(): boolean {
    return this.model.toLowerCase().includes('gpt-image');
  }

  /** OpenAI images/generations (text-to-image) call, used for generateCharacterSheet and generateImage when no reference image is available. */
  private async requestImage(
    prompt: string,
    size: string,
    logLabel: string,
  ): Promise<ImageGenerationOutput> {
    return this.sendAndParse(
      `${this.baseUrl}/images/generations`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          prompt,
          n: 1,
          size,
        }),
      },
      logLabel,
      'text-to-image',
      false,
    );
  }

  /**
   * OpenAI images/edits (image-to-image) call, used for generateImage when a
   * character-sheet reference image is available. multipart/form-data via
   * native FormData/Blob — the Content-Type header (including boundary) is
   * left for the fetch runtime to set; setting it manually would omit the
   * boundary and break parsing on the API side.
   */
  private async requestImageEdit(
    prompt: string,
    size: string,
    reference: ImageReference,
    logLabel: string,
  ): Promise<ImageGenerationOutput> {
    const formData = new FormData();
    formData.append('model', this.model);
    formData.append('prompt', prompt);
    formData.append('size', size);
    formData.append('n', '1');
    if (this.supportsInputFidelity()) {
      formData.append('input_fidelity', 'high');
    }
    formData.append(
      'image',
      new Blob([reference.buffer], { type: reference.contentType }),
      reference.filename ?? 'character-sheet.png',
    );

    const output = await this.sendAndParse(
      `${this.baseUrl}/images/edits`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: formData,
      },
      logLabel,
      'character-reference-edit',
      true,
    );
    return { ...output, usedReference: true };
  }

  /** Shared request/parse flow for both images/generations and images/edits — every field logged here is already proven safe (never prompt text, image bytes, or base64). */
  private async sendAndParse(
    url: string,
    init: RequestInit,
    logLabel: string,
    requestMode: 'text-to-image' | 'character-reference-edit',
    characterReferenceSupplied: boolean,
  ): Promise<ImageGenerationOutput> {
    let attempts = 0;
    const limiterBefore = this.rateLimiter.getDiagnostics();
    const buildDetails = (
      extra: Pick<ImageGenerationFailureDetails, 'httpStatus' | 'errorType' | 'errorCode'> = {},
    ): ImageGenerationFailureDetails => {
      const limiterAfter = this.rateLimiter.getDiagnostics();
      return {
        ...extra,
        attempts,
        limiterRetries: limiterAfter.retriesUsed - limiterBefore.retriesUsed,
        limiterWaitMs: limiterAfter.totalWaitMs - limiterBefore.totalWaitMs,
        characterReferenceSupplied,
        requestMode,
      };
    };

    let response: Response;
    try {
      response = await this.rateLimiter.schedule(logLabel, () =>
        fetchWithRetry({
          fetchImpl: this.fetchImpl,
          url,
          init,
          timeoutMs: this.timeoutMs,
          maxRetries: this.maxRetries,
          retryableStatusCodes: IMAGE_RETRYABLE_STATUS_CODES,
          onAttempt: (attempt, maxAttempts) => {
            attempts++;
            this.logger.log(
              `${logLabel} request: provider=openai model=${this.model} attempt=${attempt}/${maxAttempts}`,
            );
          },
          onRetry: (attempt, reason) => {
            this.logger.warn(`${logLabel} attempt ${attempt} failed (${reason}); retrying`);
          },
        }),
      );
    } catch (err) {
      const message =
        err instanceof OpenAIRequestError
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err);
      this.logger.error(
        `${logLabel} failed: provider=openai model=${this.model} reason=${message}`,
      );
      throw new OpenAIImageRequestError(
        `OpenAI image request failed: ${message}`,
        buildDetails(),
        err,
      );
    }

    if (!response.ok) {
      const bodyText = await response.text().catch(() => '');
      const parsed = parseOpenAIErrorBody(bodyText);
      this.logger.error(
        `${logLabel} failed: provider=openai model=${this.model} status=${response.status}${parsed.type ? ` type=${parsed.type}` : ''}${parsed.code ? ` code=${parsed.code}` : ''}`,
      );
      throw new OpenAIImageRequestError(
        `OpenAI image request failed with status ${response.status}${parsed.message ? `: ${parsed.message}` : ''}`,
        buildDetails({
          httpStatus: response.status,
          ...(parsed.type && { errorType: parsed.type }),
          ...(parsed.code && { errorCode: parsed.code }),
        }),
      );
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch (err) {
      throw new OpenAIImageRequestError(
        'OpenAI image response was not valid JSON',
        buildDetails({ httpStatus: response.status }),
        err,
      );
    }

    const b64 = (payload as { data?: Array<{ b64_json?: unknown }> })?.data?.[0]?.b64_json;
    if (typeof b64 !== 'string' || !b64) {
      throw new OpenAIImageRequestError(
        'OpenAI image response did not include b64_json data',
        buildDetails({ httpStatus: response.status }),
      );
    }

    this.logger.log(`${logLabel} succeeded: provider=openai model=${this.model}`);
    return { buffer: Buffer.from(b64, 'base64'), contentType: 'image/png' };
  }
}
