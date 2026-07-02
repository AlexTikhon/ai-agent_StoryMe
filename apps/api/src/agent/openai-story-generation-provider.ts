import { Logger } from '@nestjs/common';
import { z } from 'zod';
import {
  Pronouns,
  type BookPreview,
  type CharacterCard,
  type ChapterOutline,
  type IllustrationPlan,
  type StoryPlan,
} from '@book/types';
import {
  buildBookPreview,
  buildImageGenerationResult,
  type ResolvedPagePlan,
  type StoryGenerationInput,
  type StoryGenerationProvider,
  type StoryGenerationResult,
} from './story-generation-provider';
import {
  DEFAULT_OPENAI_MAX_RETRIES,
  DEFAULT_OPENAI_REQUEST_TIMEOUT_MS,
  fetchWithRetry,
  OpenAIRequestError,
} from '../common/openai-request';

const DEFAULT_MODEL = 'gpt-4o-mini';
const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const TARGET_PAGE_COUNT = 6;
const MIN_PAGE_COUNT = 4;
const MAX_PAGE_COUNT = 12;
const PAGES_PER_CHAPTER = 2;
const MAX_STORY_TEXT_LENGTH = 1000;

export class StoryGenerationProviderError extends Error {
  constructor(
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'StoryGenerationProviderError';
  }
}

const llmPageSchema = z.object({
  pageNumber: z.number().int().positive(),
  title: z.string().trim().min(1),
  sceneDescription: z.string().trim().min(1),
  storyText: z.string().trim().min(1).max(MAX_STORY_TEXT_LENGTH),
  illustrationPrompt: z.string().trim().min(1),
  learningGoal: z.string().trim().min(1),
});

const llmResponseSchema = z.object({
  title: z.string().trim().min(1),
  subtitle: z.string().trim().min(1).optional(),
  theme: z.string().trim().min(1),
  educationalMessage: z.string().trim().min(1),
  openingHook: z.string().trim().min(1),
  resolution: z.string().trim().min(1),
  characterCard: z.object({
    visualAnchor: z.string().trim().min(1),
    narrativeDescription: z.string().trim().min(1),
  }),
  pages: z.array(llmPageSchema).min(MIN_PAGE_COUNT).max(MAX_PAGE_COUNT),
});

export type LlmStoryGenerationResponse = z.infer<typeof llmResponseSchema>;

/**
 * Builds the system/user messages sent to the model. Kept as a pure function
 * (no network) so prompt content can be asserted on directly in tests.
 */
export function buildStoryGenerationPrompt(
  input: StoryGenerationInput,
  targetPageCount: number = TARGET_PAGE_COUNT,
): { system: string; user: string } {
  const system = [
    "You are a children's book story planner.",
    'You only ever respond with a single strict JSON object — no markdown, no prose, no code fences.',
    'The story must be safe for children: age-appropriate, no violence, no scary content, no romance, and no copyrighted or trademarked characters.',
    'Use simple, warm language a parent would comfortably read aloud to a child.',
  ].join(' ');

  const user = [
    `Write a ${targetPageCount}-page personalized children's story with these details:`,
    `- Child's name: ${input.childName}`,
    `- Child's age: ${input.childAge}`,
    `- Theme: ${input.theme}`,
    `- Language: ${input.language}`,
    '',
    'Respond with strict JSON matching exactly this shape (no extra keys, no trailing commas):',
    '{',
    '  "title": string,',
    '  "subtitle": string (optional),',
    '  "theme": string,',
    '  "educationalMessage": string,',
    '  "openingHook": string,',
    '  "resolution": string,',
    '  "characterCard": { "visualAnchor": string, "narrativeDescription": string },',
    `  "pages": [ { "pageNumber": number, "title": string, "sceneDescription": string, "storyText": string, "illustrationPrompt": string, "learningGoal": string }, ... exactly ${targetPageCount} entries, pageNumber starting at 1 ]`,
    '}',
    '',
    `Write every story field (title, storyText, learningGoal, etc.) in this language: ${input.language}.`,
    'Keep each page\'s "storyText" short (2-4 sentences) and appropriate for a young child listening or reading along.',
    'Each "illustrationPrompt" should describe a single illustration scene — setting, action, mood — suitable for a future image-generation model. Do not reference real people, brands, or copyrighted/trademarked characters, and keep every scene non-violent and non-scary.',
  ].join('\n');

  return { system, user };
}

function mapLlmResponseToResult(
  input: StoryGenerationInput,
  data: LlmStoryGenerationResponse,
): StoryGenerationResult {
  const characterCard: CharacterCard = {
    name: input.childName,
    age: input.childAge,
    pronouns: Pronouns.TheyThem,
    appearance: {
      hairColor: 'brown',
      hairStyle: 'wavy',
      eyeColor: 'brown',
      skinTone: 'medium',
      distinctiveFeatures: ['bright smile'],
    },
    personality: {
      traits: ['curious', 'brave', 'kind'],
      favoriteAnimals: ['rabbit', 'butterfly'],
      favoriteColors: ['purple', 'yellow'],
      favoriteToys: ['building blocks'],
      hobbies: ['drawing', 'exploring'],
    },
    visualAnchor: data.characterCard.visualAnchor,
    narrativeDescription: data.characterCard.narrativeDescription,
  };

  const sortedPages = [...data.pages].sort((a, b) => a.pageNumber - b.pageNumber);

  const pages: ResolvedPagePlan[] = sortedPages.map((page) => {
    const chapterIndex = Math.floor((page.pageNumber - 1) / PAGES_PER_CHAPTER);
    const illustration: IllustrationPlan = {
      prompt: `${characterCard.visualAnchor}, ${page.sceneDescription}. ${page.illustrationPrompt}`,
      negativePrompt: 'blurry, distorted face, extra limbs, scary, violent, text, watermark',
      style: 'warm children book illustration, soft colors, friendly character design',
      aspectRatio: '4:3',
      characters: [characterCard.name],
      setting: page.sceneDescription,
      mood: 'joyful, child-friendly',
      consistencyNotes: `Keep ${characterCard.name} visually consistent: ${characterCard.visualAnchor}. Use the same color palette and character design throughout.`,
    };

    return {
      pageNumber: page.pageNumber,
      chapterIndex,
      title: page.title,
      sceneDescription: page.sceneDescription,
      narration: page.storyText,
      illustrationPrompt: page.illustrationPrompt,
      learningGoal: page.learningGoal,
      storyText: page.storyText,
      illustration,
    };
  });

  const chapters: ChapterOutline[] = [];
  for (let i = 0; i < pages.length; i += PAGES_PER_CHAPTER) {
    const chapterPages = pages.slice(i, i + PAGES_PER_CHAPTER);
    const firstPage = chapterPages[0];
    const chapterNumber = chapters.length + 1;
    chapters.push({
      chapterNumber,
      title: firstPage?.title ?? `Chapter ${chapterNumber}`,
      summary: chapterPages.map((page) => page.storyText).join(' '),
      setting: firstPage?.sceneDescription ?? '',
      emotionalArc: 'wonder to joy',
      keyEvents: chapterPages.map((page) => page.sceneDescription),
      illustrableScenes: chapterPages.map((page) => page.sceneDescription),
    });
  }

  const storyPlanFinal: StoryPlan & { pages: ResolvedPagePlan[] } = {
    title: data.title,
    ...(data.subtitle !== undefined && { subtitle: data.subtitle }),
    theme: data.theme,
    educationalMessage: data.educationalMessage,
    chapters,
    openingHook: data.openingHook,
    resolution: data.resolution,
    pages,
  };

  const bookPreview: BookPreview = buildBookPreview(
    { childName: input.childName, childAge: input.childAge, language: input.language },
    characterCard,
    storyPlanFinal,
  );

  const imageGenerationResult = buildImageGenerationResult(input.bookId, bookPreview);

  return { characterCard, storyPlan: storyPlanFinal, bookPreview, imageGenerationResult };
}

export interface OpenAIStoryGenerationProviderOptions {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  targetPageCount?: number;
  timeoutMs?: number;
  maxRetries?: number;
}

/**
 * Real LLM-backed StoryGenerationProvider. Calls the OpenAI chat completions
 * API for strict JSON, validates/coerces the response with zod, and maps it
 * into the exact StoryGenerationResult shape MockStoryGenerationProvider
 * returns — AgentService and everything downstream never see raw model
 * output. Selected via createStoryGenerationProvider
 * (story-generation-provider.factory.ts); never constructed unless
 * STORY_GENERATION_PROVIDER=openai is explicitly set.
 */
export class OpenAIStoryGenerationProvider implements StoryGenerationProvider {
  private readonly logger = new Logger(OpenAIStoryGenerationProvider.name);
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly targetPageCount: number;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;

  constructor(options: OpenAIStoryGenerationProviderOptions) {
    if (!options.apiKey) {
      throw new StoryGenerationProviderError('OpenAIStoryGenerationProvider requires an apiKey');
    }
    this.apiKey = options.apiKey;
    this.model = options.model ?? DEFAULT_MODEL;
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.targetPageCount = options.targetPageCount ?? TARGET_PAGE_COUNT;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_OPENAI_REQUEST_TIMEOUT_MS;
    this.maxRetries = options.maxRetries ?? DEFAULT_OPENAI_MAX_RETRIES;
  }

  async generateStory(input: StoryGenerationInput): Promise<StoryGenerationResult> {
    const { system, user } = buildStoryGenerationPrompt(input, this.targetPageCount);

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
              { role: 'system', content: system },
              { role: 'user', content: user },
            ],
          }),
        },
        timeoutMs: this.timeoutMs,
        maxRetries: this.maxRetries,
        onAttempt: (attempt, maxAttempts) => {
          this.logger.log(
            `Story generation request: provider=openai model=${this.model} attempt=${attempt}/${maxAttempts}`,
          );
        },
        onRetry: (attempt, reason) => {
          this.logger.warn(`Story generation attempt ${attempt} failed (${reason}); retrying`);
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
        `Story generation failed: provider=openai model=${this.model} reason=${message}`,
      );
      throw new StoryGenerationProviderError(`OpenAI request failed: ${message}`, err);
    }

    if (!response.ok) {
      const bodyText = await response.text().catch(() => '');
      this.logger.error(
        `Story generation failed: provider=openai model=${this.model} status=${response.status}`,
      );
      throw new StoryGenerationProviderError(
        `OpenAI request failed with status ${response.status}: ${bodyText.slice(0, 500)}`,
      );
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch (err) {
      throw new StoryGenerationProviderError('OpenAI response was not valid JSON', err);
    }

    const content = (payload as { choices?: Array<{ message?: { content?: unknown } }> })
      ?.choices?.[0]?.message?.content;
    if (typeof content !== 'string') {
      throw new StoryGenerationProviderError('OpenAI response did not include message content');
    }

    let raw: unknown;
    try {
      raw = JSON.parse(content);
    } catch (err) {
      throw new StoryGenerationProviderError('OpenAI story content was not valid JSON', err);
    }

    const parsed = llmResponseSchema.safeParse(raw);
    if (!parsed.success) {
      throw new StoryGenerationProviderError(
        `OpenAI story content failed validation: ${parsed.error.message}`,
      );
    }

    this.logger.log(`Story generation succeeded: provider=openai model=${this.model}`);
    return mapLlmResponseToResult(input, parsed.data);
  }
}
