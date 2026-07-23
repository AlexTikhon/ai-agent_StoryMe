import { Logger } from '@nestjs/common';
import { z } from 'zod';
import type { CharacterProfile } from '@book/types';
import {
  buildConsistencyPrompt,
  type CharacterProfileInput,
  type CharacterProfileProvider,
} from './character-profile-provider';
import {
  DEFAULT_OPENAI_MAX_RETRIES,
  DEFAULT_OPENAI_REQUEST_TIMEOUT_MS,
  fetchWithRetry,
  safeOpenAIRequestFailureMessage,
} from '../common/openai-request';

const DEFAULT_MODEL = 'gpt-4o-mini';
const DEFAULT_BASE_URL = 'https://api.openai.com/v1';

export class CharacterProfileProviderError extends Error {
  constructor(
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'CharacterProfileProviderError';
  }
}

const llmResponseSchema = z.object({
  visualDescription: z.string().trim().min(1),
  faceDescription: z.string().trim().min(1),
  hairDescription: z.string().trim().min(1),
  outfitDescription: z.string().trim().min(1),
  personalitySummary: z.string().trim().min(1),
  illustrationStyle: z.string().trim().min(1),
});

export type LlmCharacterProfileResponse = z.infer<typeof llmResponseSchema>;

/**
 * System prompt enforcing the child-safety boundaries required of this
 * provider: describe only non-sensitive visual traits suitable for a
 * stylized children's-book caricature, never a realistic identity-matching
 * portrait, and never infer sensitive attributes.
 */
const SYSTEM_PROMPT = [
  "You are a children's book character designer.",
  'You only ever respond with a single strict JSON object — no markdown, no prose, no code fences.',
  'When a reference photo is provided, describe only non-sensitive, visible traits useful for a stylized illustration: general face shape, hairstyle, hair color, eye shape, smile, and general expression.',
  'Never infer or mention race, ethnicity, health, disability, religion, or any other sensitive attribute.',
  'Never describe the child in a way that would let an illustrator reproduce a realistic, identity-matching portrait — you are designing a warm, stylized, child-safe caricature for a picture book, not a photorealistic likeness.',
  "The described character and outfit must be appropriate and modest for a children's picture book.",
].join(' ');

/**
 * Builds the user message content sent to the model: text instructions plus
 * (only when a photo was supplied) an OpenAI vision `image_url` content
 * part. This is the sole place a child's photo bytes are ever transmitted —
 * as vision input to a text-description call, never to an image-generation
 * or image-edit endpoint. Exported for tests to assert the image part is
 * included/excluded correctly without mocking fetch.
 */
export function buildCharacterProfileMessageContent(
  input: CharacterProfileInput,
): Array<Record<string, unknown>> {
  const instructions = [
    `Describe a stylized children's-book character based on:`,
    `- Child's name: ${input.childName}`,
    `- Child's age: ${input.childAge}`,
    `- Story theme: ${input.theme}`,
    `- Language: ${input.language}`,
    input.photo
      ? 'A reference photo of the child is attached below — use it only as inspiration for non-sensitive visual traits (face shape, hairstyle, hair color, eye shape, smile, expression). Do not attempt to reproduce a realistic likeness.'
      : 'No reference photo was provided — invent warm, generic, child-safe visual traits appropriate for the given age.',
    '',
    'Respond with strict JSON matching exactly this shape (no extra keys):',
    '{',
    '  "visualDescription": string,',
    '  "faceDescription": string,',
    '  "hairDescription": string,',
    '  "outfitDescription": string,',
    '  "personalitySummary": string,',
    '  "illustrationStyle": string',
    '}',
    '',
    'Keep every field short (1 sentence), warm, and suitable for guiding an illustrator drawing the same stylized character consistently across many pages.',
  ].join('\n');

  const content: Array<Record<string, unknown>> = [{ type: 'text', text: instructions }];
  if (input.photo) {
    content.push({
      type: 'image_url',
      image_url: { url: `data:${input.photo.contentType};base64,${input.photo.base64}` },
    });
  }
  return content;
}

function mapLlmResponseToProfile(
  input: CharacterProfileInput,
  data: LlmCharacterProfileResponse,
): CharacterProfile {
  const profile: CharacterProfile = {
    childName: input.childName,
    age: input.childAge,
    visualDescription: data.visualDescription,
    faceDescription: data.faceDescription,
    hairDescription: data.hairDescription,
    outfitDescription: data.outfitDescription,
    personalitySummary: data.personalitySummary,
    illustrationStyle: data.illustrationStyle,
    consistencyPrompt: '',
    hasReferencePhoto: input.photo != null,
    hasCharacterSheet: false,
  };
  profile.consistencyPrompt = buildConsistencyPrompt(profile);
  return profile;
}

export interface OpenAICharacterProfileProviderOptions {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxRetries?: number;
}

/**
 * Real vision-backed CharacterProfileProvider. Calls the OpenAI chat
 * completions API (vision-capable model) for strict JSON, validates/coerces
 * the response with zod, and maps it into the exact CharacterProfile shape
 * MockCharacterProfileProvider returns. Selected via
 * createCharacterProfileProvider (character-profile-provider.factory.ts);
 * never constructed unless CHARACTER_PROFILE_PROVIDER=openai is explicitly
 * set. Works identically with or without a photo.
 */
export class OpenAICharacterProfileProvider implements CharacterProfileProvider {
  readonly providerName = 'openai' as const;
  readonly promptVersion = 'openai-character-profile-v1';
  private readonly logger = new Logger(OpenAICharacterProfileProvider.name);
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;

  constructor(options: OpenAICharacterProfileProviderOptions) {
    if (!options.apiKey) {
      throw new CharacterProfileProviderError('OpenAICharacterProfileProvider requires an apiKey');
    }
    this.apiKey = options.apiKey;
    this.model = options.model ?? DEFAULT_MODEL;
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_OPENAI_REQUEST_TIMEOUT_MS;
    this.maxRetries = options.maxRetries ?? DEFAULT_OPENAI_MAX_RETRIES;
  }

  get modelName(): string {
    return this.model;
  }

  async buildProfile(input: CharacterProfileInput): Promise<CharacterProfile> {
    const content = buildCharacterProfileMessageContent(input);

    let response: Response;
    try {
      response = await fetchWithRetry({
        fetchImpl: this.fetchImpl,
        url: `${this.baseUrl}/chat/completions`,
        init: {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify({
            model: this.model,
            response_format: { type: 'json_object' },
            temperature: 0.7,
            messages: [
              { role: 'system', content: SYSTEM_PROMPT },
              { role: 'user', content },
            ],
          }),
        },
        timeoutMs: this.timeoutMs,
        maxRetries: this.maxRetries,
        onAttempt: (attempt, maxAttempts) => {
          this.logger.log(
            `Character profile request: provider=openai model=${this.model} attempt=${attempt}/${maxAttempts}`,
          );
        },
        onRetry: (attempt, reason) => {
          this.logger.warn(`Character profile attempt ${attempt} failed (${reason}); retrying`);
        },
      });
    } catch (err) {
      const message = safeOpenAIRequestFailureMessage(err);
      this.logger.error(
        `Character profile request failed: provider=openai model=${this.model} reason=${message}`,
      );
      throw new CharacterProfileProviderError(`OpenAI request failed: ${message}`, err);
    }

    if (!response.ok) {
      this.logger.error(
        `Character profile request failed: provider=openai model=${this.model} status=${response.status}`,
      );
      throw new CharacterProfileProviderError(
        `OpenAI request failed with status ${response.status}`,
      );
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch (err) {
      throw new CharacterProfileProviderError('OpenAI response was not valid JSON', err);
    }

    const messageContent = (payload as { choices?: Array<{ message?: { content?: unknown } }> })
      ?.choices?.[0]?.message?.content;
    if (typeof messageContent !== 'string') {
      throw new CharacterProfileProviderError('OpenAI response did not include message content');
    }

    let raw: unknown;
    try {
      raw = JSON.parse(messageContent);
    } catch (err) {
      throw new CharacterProfileProviderError(
        'OpenAI character profile content was not valid JSON',
        err,
      );
    }

    const parsed = llmResponseSchema.safeParse(raw);
    if (!parsed.success) {
      throw new CharacterProfileProviderError(
        `OpenAI character profile content failed validation: ${parsed.error.message}`,
      );
    }

    this.logger.log(`Character profile generation succeeded: provider=openai model=${this.model}`);
    return mapLlmResponseToProfile(input, parsed.data);
  }
}
