import { Logger } from '@nestjs/common';
import type { CharacterCard, GeneratedImageEntry } from '@book/types';
import type {
  ImageGenerationInput,
  ImageGenerationOutput,
  ImageGenerationProvider,
} from './image-generation-provider';
import {
  DEFAULT_OPENAI_MAX_RETRIES,
  DEFAULT_OPENAI_REQUEST_TIMEOUT_MS,
  fetchWithRetry,
  OpenAIRequestError,
} from '../common/openai-request';

const DEFAULT_MODEL = 'gpt-image-1';
const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_SIZE = '1024x1024';
const DEFAULT_MAX_PAGES = 12;

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
    'Keep the protagonist visually consistent with the description above across every illustration.',
    'No text, no captions, no letters, no watermarks, no logos.',
  ].join(' ');
}

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
}

/**
 * Real image-generation ImageGenerationProvider. Calls the OpenAI images API
 * for one base64-encoded PNG per page/cover entry and maps it into the exact
 * ImageGenerationOutput shape MockImageGenerationProvider returns —
 * AgentService and everything downstream (ImageAssetStorage, PDF renderer)
 * never see raw API response shapes. Selected via
 * createImageGenerationProvider (image-generation-provider.factory.ts);
 * never constructed unless IMAGE_GENERATION_PROVIDER_TOKEN=openai is
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
  }

  get modelName(): string {
    return this.model;
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

    const prompt = buildImagePrompt(input.characterCard, input.entry);

    let response: Response;
    try {
      response = await fetchWithRetry({
        fetchImpl: this.fetchImpl,
        url: `${this.baseUrl}/images/generations`,
        init: {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify({
            model: this.model,
            prompt,
            n: 1,
            size: sizeForEntry(input.entry),
          }),
        },
        timeoutMs: this.timeoutMs,
        maxRetries: this.maxRetries,
        onAttempt: (attempt, maxAttempts) => {
          this.logger.log(
            `Image generation request: provider=openai model=${this.model} attempt=${attempt}/${maxAttempts}`,
          );
        },
        onRetry: (attempt, reason) => {
          this.logger.warn(`Image generation attempt ${attempt} failed (${reason}); retrying`);
        },
      });
    } catch (err) {
      const message =
        err instanceof OpenAIRequestError
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err);
      this.logger.error(
        `Image generation failed: provider=openai model=${this.model} reason=${message}`,
      );
      throw new ImageGenerationProviderError(`OpenAI image request failed: ${message}`, err);
    }

    if (!response.ok) {
      const bodyText = await response.text().catch(() => '');
      this.logger.error(
        `Image generation failed: provider=openai model=${this.model} status=${response.status}`,
      );
      throw new ImageGenerationProviderError(
        `OpenAI image request failed with status ${response.status}: ${bodyText.slice(0, 500)}`,
      );
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch (err) {
      throw new ImageGenerationProviderError('OpenAI image response was not valid JSON', err);
    }

    const b64 = (payload as { data?: Array<{ b64_json?: unknown }> })?.data?.[0]?.b64_json;
    if (typeof b64 !== 'string' || !b64) {
      throw new ImageGenerationProviderError('OpenAI image response did not include b64_json data');
    }

    this.logger.log(`Image generation succeeded: provider=openai model=${this.model}`);
    return { buffer: Buffer.from(b64, 'base64'), contentType: 'image/png' };
  }
}
