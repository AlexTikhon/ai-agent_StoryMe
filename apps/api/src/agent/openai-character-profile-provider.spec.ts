import { describe, it, expect, vi } from 'vitest';
import {
  OpenAICharacterProfileProvider,
  CharacterProfileProviderError,
  buildCharacterProfileMessageContent,
} from './openai-character-profile-provider';
import type { CharacterProfileInput } from './character-profile-provider';

function makeInput(overrides: Partial<CharacterProfileInput> = {}): CharacterProfileInput {
  return {
    bookId: 'b-1',
    childName: 'Mia',
    childAge: 5,
    theme: 'friendship',
    language: 'en',
    ...overrides,
  };
}

function makeValidLlmPayload() {
  return {
    visualDescription: 'a cheerful child with a round friendly face',
    faceDescription: 'a round, friendly face with a warm smile',
    hairDescription: 'short wavy brown hair',
    outfitDescription: 'a bright yellow overall with sneakers',
    personalitySummary: 'curious, brave, and kind',
    illustrationStyle: 'warm children book illustration, soft colors, friendly character design',
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

describe('buildCharacterProfileMessageContent', () => {
  it('includes childName, age, theme, and language in the text instructions', () => {
    const content = buildCharacterProfileMessageContent(
      makeInput({ childName: 'Leo', childAge: 7, theme: 'space', language: 'fr' }),
    );
    const text = content.find((part) => part['type'] === 'text')?.['text'] as string;

    expect(text).toContain('Leo');
    expect(text).toContain('7');
    expect(text).toContain('space');
    expect(text).toContain('fr');
  });

  it('omits the image_url part when no photo is supplied', () => {
    const content = buildCharacterProfileMessageContent(makeInput());
    expect(content.some((part) => part['type'] === 'image_url')).toBe(false);
  });

  it('includes an image_url data URI part only when a photo is supplied', () => {
    const content = buildCharacterProfileMessageContent(
      makeInput({ photo: { base64: 'ZmFrZS1ieXRlcw==', contentType: 'image/jpeg' } }),
    );
    const imagePart = content.find((part) => part['type'] === 'image_url') as
      { image_url: { url: string } } | undefined;

    expect(imagePart).toBeDefined();
    expect(imagePart?.image_url.url).toBe('data:image/jpeg;base64,ZmFrZS1ieXRlcw==');
  });
});

describe('OpenAICharacterProfileProvider', () => {
  it('throws when constructed without an apiKey', () => {
    expect(() => new OpenAICharacterProfileProvider({ apiKey: '' })).toThrow(
      CharacterProfileProviderError,
    );
  });

  it('sends a system prompt enforcing child-safety boundaries', async () => {
    const fetchImpl = makeFetchOk(JSON.stringify(makeValidLlmPayload()));
    const provider = new OpenAICharacterProfileProvider({ apiKey: 'sk-test', fetchImpl });

    await provider.buildProfile(makeInput());

    const body = JSON.parse(fetchImpl.mock.calls[0]![1].body as string);
    const systemMessage = body.messages.find((m: { role: string }) => m.role === 'system');
    expect(systemMessage.content).toMatch(/stylized/i);
    expect(systemMessage.content).toMatch(/never infer or mention race, ethnicity/i);
    expect(systemMessage.content).toMatch(/not a photorealistic likeness/i);
  });

  it('maps a successful response to the CharacterProfile shape', async () => {
    const fetchImpl = makeFetchOk(JSON.stringify(makeValidLlmPayload()));
    const provider = new OpenAICharacterProfileProvider({ apiKey: 'sk-test', fetchImpl });

    const result = await provider.buildProfile(makeInput({ childName: 'Mia', childAge: 5 }));

    expect(result.childName).toBe('Mia');
    expect(result.age).toBe(5);
    expect(result.faceDescription).toBe('a round, friendly face with a warm smile');
    expect(result.consistencyPrompt).toContain('Mia');
    expect(result.hasReferencePhoto).toBe(false);
    expect(result.hasCharacterSheet).toBe(false);
  });

  it('sets hasReferencePhoto true when a photo was supplied', async () => {
    const fetchImpl = makeFetchOk(JSON.stringify(makeValidLlmPayload()));
    const provider = new OpenAICharacterProfileProvider({ apiKey: 'sk-test', fetchImpl });

    const result = await provider.buildProfile(
      makeInput({ photo: { base64: 'ZmFrZS1ieXRlcw==', contentType: 'image/jpeg' } }),
    );

    expect(result.hasReferencePhoto).toBe(true);
  });

  it('throws a clear error when the HTTP response is not ok', async () => {
    const text = vi.fn().mockResolvedValue('invalid api key');
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({}),
      text,
    });
    const provider = new OpenAICharacterProfileProvider({ apiKey: 'sk-bad', fetchImpl });

    await expect(provider.buildProfile(makeInput())).rejects.toThrow(/status 401/);
    expect(text).not.toHaveBeenCalled();
  });

  it('throws a clear error when the response content fails schema validation', async () => {
    const fetchImpl = makeFetchOk(JSON.stringify({ visualDescription: 'only one field' }));
    const provider = new OpenAICharacterProfileProvider({ apiKey: 'sk-test', fetchImpl });

    await expect(provider.buildProfile(makeInput())).rejects.toThrow(/failed validation/);
  });

  it('throws a clear error when the response is not valid JSON', async () => {
    const fetchImpl = makeFetchOk('not json');
    const provider = new OpenAICharacterProfileProvider({ apiKey: 'sk-test', fetchImpl });

    await expect(provider.buildProfile(makeInput())).rejects.toThrow(/not valid JSON/);
  });

  it('does not leak the API key in a thrown error message', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('network down'));
    const provider = new OpenAICharacterProfileProvider({
      apiKey: 'sk-super-secret-key',
      fetchImpl,
      maxRetries: 0,
    });

    try {
      await provider.buildProfile(makeInput());
      throw new Error('expected buildProfile to reject');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      expect(message).toContain('OpenAI request failed due to a network error');
      expect(message).not.toContain('network down');
      expect(message).not.toContain('sk-super-secret-key');
    }
  });
});
