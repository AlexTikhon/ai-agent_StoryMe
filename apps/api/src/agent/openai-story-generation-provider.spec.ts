import { describe, it, expect, vi } from 'vitest';
import type { CharacterProfile } from '@book/types';
import {
  OpenAIStoryGenerationProvider,
  StoryGenerationProviderError,
  buildStoryGenerationPrompt,
} from './openai-story-generation-provider';
import type { StoryGenerationInput } from './story-generation-provider';

const DEFAULT_CHARACTER_PROFILE: CharacterProfile = {
  childName: 'Mia',
  age: 5,
  visualDescription: 'a cheerful child with a round friendly face',
  faceDescription: 'a round, friendly face with a warm smile',
  hairDescription: 'short wavy brown hair',
  outfitDescription: 'a bright yellow overall with sneakers',
  personalitySummary: 'curious, brave, and kind',
  illustrationStyle: 'warm children book illustration, soft colors, friendly character design',
  consistencyPrompt:
    "Mia, a stylized 5-year-old children's-book character with a round, friendly face with a warm smile, short wavy brown hair, wearing a bright yellow overall with sneakers",
  hasReferencePhoto: false,
  hasCharacterSheet: false,
};

function makeInput(overrides: Partial<StoryGenerationInput> = {}): StoryGenerationInput {
  return {
    bookId: 'book-1',
    childName: 'Mia',
    childAge: 5,
    theme: 'friendship',
    language: 'en',
    characterProfile: DEFAULT_CHARACTER_PROFILE,
    ...overrides,
  };
}

function makeValidLlmPayload(pageCount = 6) {
  return {
    title: "Mia's Friendship Adventure",
    subtitle: 'A story for Mia',
    theme: 'friendship',
    educationalMessage: 'Kindness matters.',
    openingHook: 'One morning, Mia met a new friend.',
    resolution: 'Mia and her friend played happily ever after.',
    characterCard: {
      visualAnchor: 'A 5-year-old child named Mia with a bright smile',
      narrativeDescription: 'Mia is a kind and curious child.',
    },
    pages: Array.from({ length: pageCount }, (_, i) => ({
      pageNumber: i + 1,
      title: `Page ${i + 1}`,
      sceneDescription: `Mia explores scene ${i + 1}`,
      storyText: `Mia had a wonderful time on page ${i + 1}.`,
      illustrationPrompt: `Mia smiling in scene ${i + 1}, bright colors`,
      learningGoal: 'Kindness matters.',
    })),
  };
}

function makeFetchOk(content: string) {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message: { content } }] }),
    text: async () => '',
  });
}

describe('buildStoryGenerationPrompt', () => {
  it('includes childName, childAge, theme, language, and target page count', () => {
    const input = makeInput({ childName: 'Leo', childAge: 7, theme: 'space', language: 'fr' });
    const { user } = buildStoryGenerationPrompt(input, 8);

    expect(user).toContain('Leo');
    expect(user).toContain('7');
    expect(user).toContain('space');
    expect(user).toContain('fr');
    expect(user).toContain('8-page');
  });

  it('instructs the model to avoid unsafe or copyrighted content', () => {
    const { system, user } = buildStoryGenerationPrompt(makeInput());
    expect(system + user).toMatch(/copyrighted|trademarked/i);
    expect(system + user).toMatch(/violen|scary/i);
  });
});

describe('OpenAIStoryGenerationProvider', () => {
  it('throws when constructed without an apiKey', () => {
    expect(() => new OpenAIStoryGenerationProvider({ apiKey: '' })).toThrow(
      StoryGenerationProviderError,
    );
  });

  it('maps a valid LLM JSON response to the StoryGenerationResult shape', async () => {
    const fetchImpl = makeFetchOk(JSON.stringify(makeValidLlmPayload(6)));
    const provider = new OpenAIStoryGenerationProvider({ apiKey: 'sk-test', fetchImpl });

    const result = await provider.generateStory(makeInput());

    expect(result.characterCard.name).toBe('Mia');
    expect(result.characterCard.visualAnchor).toContain('Mia');
    expect(result.storyPlan.pages).toHaveLength(6);
    expect(result.storyPlan.pages[0]?.illustration.prompt).toContain('Mia');
    expect(result.bookPreview.pages).toHaveLength(6);
    expect(result.imageGenerationResult.provider).toBe('local_mock');
    expect(result.imageGenerationResult.images).toHaveLength(8); // 6 pages + cover + back cover
  });

  it('sends the model, auth header, and json_object response format', async () => {
    const fetchImpl = makeFetchOk(JSON.stringify(makeValidLlmPayload(6)));
    const provider = new OpenAIStoryGenerationProvider({
      apiKey: 'sk-test',
      model: 'gpt-test-model',
      baseUrl: 'https://example.test/v1',
      fetchImpl,
    });

    await provider.generateStory(makeInput());

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://example.test/v1/chat/completions',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer sk-test' }),
      }),
    );
    const body = JSON.parse(fetchImpl.mock.calls[0]![1].body as string);
    expect(body.model).toBe('gpt-test-model');
    expect(body.response_format).toEqual({ type: 'json_object' });
  });

  it('uses the per-call input.pageCount over the constructor default (Phase 4A)', async () => {
    const fetchImpl = makeFetchOk(JSON.stringify(makeValidLlmPayload(4)));
    const provider = new OpenAIStoryGenerationProvider({
      apiKey: 'sk-test',
      fetchImpl,
      targetPageCount: 6,
    });

    await provider.generateStory(makeInput({ pageCount: 4 }));

    const body = JSON.parse(fetchImpl.mock.calls[0]![1].body as string);
    const userMessage = body.messages[1].content as string;
    expect(userMessage).toContain('4-page');
  });

  it('falls back to the constructor targetPageCount when input.pageCount is omitted', async () => {
    const fetchImpl = makeFetchOk(JSON.stringify(makeValidLlmPayload(8)));
    const provider = new OpenAIStoryGenerationProvider({
      apiKey: 'sk-test',
      fetchImpl,
      targetPageCount: 8,
    });

    await provider.generateStory(makeInput());

    const body = JSON.parse(fetchImpl.mock.calls[0]![1].body as string);
    const userMessage = body.messages[1].content as string;
    expect(userMessage).toContain('8-page');
  });

  it('includes the educationalMessage guidance in the prompt when provided (Phase 4A)', async () => {
    const fetchImpl = makeFetchOk(JSON.stringify(makeValidLlmPayload(6)));
    const provider = new OpenAIStoryGenerationProvider({ apiKey: 'sk-test', fetchImpl });

    await provider.generateStory(makeInput({ educationalMessage: 'It is okay to make mistakes' }));

    const body = JSON.parse(fetchImpl.mock.calls[0]![1].body as string);
    const userMessage = body.messages[1].content as string;
    expect(userMessage).toContain('It is okay to make mistakes');
  });

  it('throws a clear error when the response content is not valid JSON', async () => {
    const fetchImpl = makeFetchOk('not json at all');
    const provider = new OpenAIStoryGenerationProvider({ apiKey: 'sk-test', fetchImpl });

    await expect(provider.generateStory(makeInput())).rejects.toThrow(StoryGenerationProviderError);
  });

  it('throws a clear error when the JSON is structurally invalid', async () => {
    const invalidPayload = { ...makeValidLlmPayload(6), pages: [] };
    const fetchImpl = makeFetchOk(JSON.stringify(invalidPayload));
    const provider = new OpenAIStoryGenerationProvider({ apiKey: 'sk-test', fetchImpl });

    await expect(provider.generateStory(makeInput())).rejects.toThrow(/failed validation/);
  });

  it('throws a clear error when the HTTP response is not ok', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({}),
      text: async () => 'invalid api key',
    });
    const provider = new OpenAIStoryGenerationProvider({ apiKey: 'sk-bad', fetchImpl });

    await expect(provider.generateStory(makeInput())).rejects.toThrow(/status 401/);
  });

  it('throws a clear error when fetch itself rejects', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('network down'));
    const provider = new OpenAIStoryGenerationProvider({
      apiKey: 'sk-test',
      fetchImpl,
      maxRetries: 0,
    });

    await expect(provider.generateStory(makeInput())).rejects.toThrow(/network down/);
  });

  it('throws a StoryGenerationProviderError when the request times out', async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = vi.fn((_url: string, init: RequestInit) => {
        return new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            const err = new Error('The operation was aborted');
            err.name = 'AbortError';
            reject(err);
          });
        });
      });
      const provider = new OpenAIStoryGenerationProvider({
        apiKey: 'sk-test',
        fetchImpl,
        timeoutMs: 50,
        maxRetries: 0,
      });

      const promise = provider.generateStory(makeInput());
      const assertion = expect(promise).rejects.toThrow(StoryGenerationProviderError);
      await vi.advanceTimersByTimeAsync(50);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it('retries once on HTTP 429 and succeeds on the second attempt', async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce({
          ok: false,
          status: 429,
          json: async () => ({}),
          text: async () => 'rate limited',
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({
            choices: [{ message: { content: JSON.stringify(makeValidLlmPayload(6)) } }],
          }),
          text: async () => '',
        });
      const provider = new OpenAIStoryGenerationProvider({
        apiKey: 'sk-test',
        fetchImpl,
        maxRetries: 1,
        timeoutMs: 5000,
      });

      const promise = provider.generateStory(makeInput());
      await vi.advanceTimersByTimeAsync(5000);
      const result = await promise;

      expect(fetchImpl).toHaveBeenCalledTimes(2);
      expect(result.characterCard.name).toBe('Mia');
    } finally {
      vi.useRealTimers();
    }
  });

  it('retries on HTTP 500 and succeeds on the second attempt', async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce({
          ok: false,
          status: 500,
          json: async () => ({}),
          text: async () => 'server error',
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({
            choices: [{ message: { content: JSON.stringify(makeValidLlmPayload(6)) } }],
          }),
          text: async () => '',
        });
      const provider = new OpenAIStoryGenerationProvider({
        apiKey: 'sk-test',
        fetchImpl,
        maxRetries: 1,
        timeoutMs: 5000,
      });

      const promise = provider.generateStory(makeInput());
      await vi.advanceTimersByTimeAsync(5000);
      const result = await promise;

      expect(fetchImpl).toHaveBeenCalledTimes(2);
      expect(result.storyPlan.pages).toHaveLength(6);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not retry on HTTP 400', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({}),
      text: async () => 'bad request',
    });
    const provider = new OpenAIStoryGenerationProvider({
      apiKey: 'sk-test',
      fetchImpl,
      maxRetries: 2,
    });

    await expect(provider.generateStory(makeInput())).rejects.toThrow(/status 400/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('does not retry on HTTP 401', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({}),
      text: async () => 'invalid api key',
    });
    const provider = new OpenAIStoryGenerationProvider({
      apiKey: 'sk-test',
      fetchImpl,
      maxRetries: 2,
    });

    await expect(provider.generateStory(makeInput())).rejects.toThrow(/status 401/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('does not retry a schema validation failure', async () => {
    const invalidPayload = { ...makeValidLlmPayload(6), pages: [] };
    const fetchImpl = makeFetchOk(JSON.stringify(invalidPayload));
    const provider = new OpenAIStoryGenerationProvider({
      apiKey: 'sk-test',
      fetchImpl,
      maxRetries: 2,
    });

    await expect(provider.generateStory(makeInput())).rejects.toThrow(/failed validation/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('does not leak the API key in a thrown error message', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('network down'));
    const provider = new OpenAIStoryGenerationProvider({
      apiKey: 'sk-super-secret-key',
      fetchImpl,
      maxRetries: 0,
    });

    try {
      await provider.generateStory(makeInput());
      throw new Error('expected generateStory to reject');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      expect(message).not.toContain('sk-super-secret-key');
    }
  });
});
