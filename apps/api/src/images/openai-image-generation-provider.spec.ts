import { describe, it, expect, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import {
  OpenAIImageGenerationProvider,
  ImageGenerationProviderError,
  OpenAIImageRequestError,
  buildImagePrompt,
  buildReferenceImagePrompt,
  buildCharacterSheetPrompt,
} from './openai-image-generation-provider';
import type { ImageGenerationInput, ImageReference } from './image-generation-provider';
import { OpenAIImageRateLimiter } from './openai-image-rate-limiter';
import { DEFAULT_OPENAI_IMAGE_REQUEST_TIMEOUT_MS } from '../common/openai-request';
import {
  Pronouns,
  type CharacterCard,
  type CharacterProfile,
  type GeneratedImageEntry,
} from '@book/types';

function makeAbortableFetch() {
  return vi.fn((_url: string, init: RequestInit) => {
    return new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => {
        const err = new Error('The operation was aborted');
        err.name = 'AbortError';
        reject(err);
      });
    });
  });
}

function makeCharacterProfile(overrides: Partial<CharacterProfile> = {}): CharacterProfile {
  return {
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
    ...overrides,
  };
}

function makeCharacterCard(overrides: Partial<CharacterCard> = {}): CharacterCard {
  return {
    name: 'Mia',
    age: 5,
    pronouns: Pronouns.SheHer,
    appearance: {
      hairColor: 'brown',
      hairStyle: 'wavy',
      eyeColor: 'brown',
      skinTone: 'medium',
      distinctiveFeatures: ['bright smile'],
    },
    personality: {
      traits: ['curious'],
      favoriteAnimals: ['rabbit'],
      favoriteColors: ['purple'],
      favoriteToys: ['blocks'],
      hobbies: ['drawing'],
    },
    visualAnchor: 'A 5-year-old child named Mia with wavy brown hair',
    narrativeDescription: 'Mia is curious and brave.',
    ...overrides,
  };
}

function makeEntry(overrides: Partial<GeneratedImageEntry> = {}): GeneratedImageEntry {
  return {
    id: 'b-1-cover',
    kind: 'cover',
    prompt: 'Mia standing in a sunny garden',
    provider: 'local_mock',
    status: 'complete',
    imageUrl: '/mock-images/b-1/cover.svg',
    altText: 'Cover illustration',
    width: 768,
    height: 1024,
    seed: 'b-1:cover:0',
    ...overrides,
  };
}

function makeInput(overrides: Partial<ImageGenerationInput> = {}): ImageGenerationInput {
  return {
    bookId: 'b-1',
    entry: makeEntry(),
    characterCard: makeCharacterCard(),
    ...overrides,
  };
}

function makeReference(overrides: Partial<ImageReference> = {}): ImageReference {
  return {
    buffer: Buffer.from('fake-character-sheet-bytes'),
    contentType: 'image/png',
    ...overrides,
  };
}

const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

function makeFetchOk(b64Json = TINY_PNG_BASE64) {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ data: [{ b64_json: b64Json }] }),
    text: async () => '',
  });
}

describe('buildImagePrompt', () => {
  it('includes visualAnchor, narrativeDescription, and the scene prompt', () => {
    const prompt = buildImagePrompt(
      { visualAnchor: 'A brave child named Leo', narrativeDescription: 'Leo loves space.' },
      { prompt: 'Leo exploring a spaceship' },
    );

    expect(prompt).toContain('A brave child named Leo');
    expect(prompt).toContain('Leo loves space.');
    expect(prompt).toContain('Leo exploring a spaceship');
  });

  it('instructs no text, letters, captions, or watermarks', () => {
    const prompt = buildImagePrompt(
      { visualAnchor: 'anchor', narrativeDescription: 'desc' },
      { prompt: 'scene' },
    );

    expect(prompt).toMatch(/no text/i);
    expect(prompt).toMatch(/no letters/i);
    expect(prompt).toMatch(/no captions/i);
    expect(prompt).toMatch(/watermark/i);
  });

  it('asks for environment, action, emotion, lighting, and composition', () => {
    const prompt = buildImagePrompt(
      { visualAnchor: 'anchor', narrativeDescription: 'desc' },
      { prompt: 'scene' },
    );

    expect(prompt).toMatch(/environment/i);
    expect(prompt).toMatch(/action/i);
    expect(prompt).toMatch(/emotion/i);
    expect(prompt).toMatch(/lighting/i);
    expect(prompt).toMatch(/composition/i);
  });

  it("instructs the character's age/face/hairstyle/outfit to stay identical across illustrations", () => {
    const prompt = buildImagePrompt(
      { visualAnchor: 'anchor', narrativeDescription: 'desc' },
      { prompt: 'scene' },
    );

    expect(prompt).toMatch(/age/i);
    expect(prompt).toMatch(/hairstyle/i);
    expect(prompt).toMatch(/identical/i);
  });
});

describe('buildReferenceImagePrompt', () => {
  it('instructs using the attached reference sheet as the authoritative visual identity source', () => {
    const prompt = buildReferenceImagePrompt(
      { visualAnchor: 'A brave child named Leo', narrativeDescription: 'Leo loves space.' },
      { prompt: 'Leo exploring a spaceship' },
    );

    expect(prompt).toMatch(/attached character reference sheet/i);
    expect(prompt).toMatch(/authoritative visual reference/i);
    expect(prompt).toContain('Leo exploring a spaceship');
  });

  it('preserves identity fields from the reference sheet: age, face shape, hairstyle, hair color, eyes, outfit, proportions, style', () => {
    const prompt = buildReferenceImagePrompt(
      { visualAnchor: 'anchor', narrativeDescription: 'desc' },
      { prompt: 'scene' },
    );

    expect(prompt).toMatch(/age/i);
    expect(prompt).toMatch(/face shape/i);
    expect(prompt).toMatch(/hairstyle/i);
    expect(prompt).toMatch(/hair color/i);
    expect(prompt).toMatch(/eye appearance/i);
    expect(prompt).toMatch(/outfit/i);
    expect(prompt).toMatch(/proportions/i);
    expect(prompt).toMatch(/illustration style/i);
  });

  it('instructs not to redraw the reference sheet itself and not to duplicate the protagonist', () => {
    const prompt = buildReferenceImagePrompt(
      { visualAnchor: 'anchor', narrativeDescription: 'desc' },
      { prompt: 'scene' },
    );

    expect(prompt).toMatch(/do not redraw/i);
    expect(prompt).toMatch(/never a second copy/i);
    expect(prompt).toMatch(/reference-sheet layout/i);
  });

  it('allows pose and expression to change per scene instead of demanding an identical pose', () => {
    const prompt = buildReferenceImagePrompt(
      { visualAnchor: 'anchor', narrativeDescription: 'desc' },
      { prompt: 'scene' },
    );

    expect(prompt).toMatch(/pose and facial expression should change naturally/i);
    expect(prompt).not.toMatch(/keep the protagonist visually identical/i);
  });

  it('still includes the scene environment/action/emotion/lighting/composition instructions', () => {
    const prompt = buildReferenceImagePrompt(
      { visualAnchor: 'anchor', narrativeDescription: 'desc' },
      { prompt: 'scene' },
    );

    expect(prompt).toMatch(/environment/i);
    expect(prompt).toMatch(/action/i);
    expect(prompt).toMatch(/emotion/i);
    expect(prompt).toMatch(/lighting/i);
    expect(prompt).toMatch(/composition/i);
  });
});

describe('buildCharacterSheetPrompt', () => {
  it('includes full-body/front-view framing, the outfit, and the illustration style', () => {
    const prompt = buildCharacterSheetPrompt(makeCharacterProfile());

    expect(prompt).toMatch(/full-body/i);
    expect(prompt).toMatch(/front-view/i);
    expect(prompt).toContain('a bright yellow overall with sneakers');
    expect(prompt).toContain(
      'warm children book illustration, soft colors, friendly character design',
    );
  });

  it('instructs no text and a stylized, non-photorealistic caricature', () => {
    const prompt = buildCharacterSheetPrompt(makeCharacterProfile());

    expect(prompt).toMatch(/no text/i);
    expect(prompt).toMatch(/stylized/i);
    expect(prompt).toMatch(/not a realistic photographic portrait/i);
  });
});

describe('OpenAIImageGenerationProvider', () => {
  it('throws when constructed without an apiKey', () => {
    expect(() => new OpenAIImageGenerationProvider({ apiKey: '' })).toThrow(
      ImageGenerationProviderError,
    );
  });

  it('sends the expected request shape via the injectable fetchImpl', async () => {
    const fetchImpl = makeFetchOk();
    const provider = new OpenAIImageGenerationProvider({
      apiKey: 'sk-test',
      model: 'gpt-image-test',
      baseUrl: 'https://example.test/v1',
      fetchImpl,
    });

    await provider.generateImage(makeInput());

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://example.test/v1/images/generations',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer sk-test' }),
      }),
    );
    const body = JSON.parse(fetchImpl.mock.calls[0]![1].body as string);
    expect(body.model).toBe('gpt-image-test');
    expect(body.n).toBe(1);
    expect(typeof body.prompt).toBe('string');
    expect(body.prompt).toContain('Mia');
  });

  it('maps a successful response to the ImageGenerationOutput shape', async () => {
    const fetchImpl = makeFetchOk();
    const provider = new OpenAIImageGenerationProvider({ apiKey: 'sk-test', fetchImpl });

    const result = await provider.generateImage(makeInput());

    expect(Buffer.isBuffer(result.buffer)).toBe(true);
    expect(result.buffer.length).toBeGreaterThan(0);
    expect(result.contentType).toBe('image/png');
    expect(result.buffer.equals(Buffer.from(TINY_PNG_BASE64, 'base64'))).toBe(true);
  });

  it('throws a clear error when the HTTP response is not ok', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({}),
      text: async () => 'invalid api key',
    });
    const provider = new OpenAIImageGenerationProvider({ apiKey: 'sk-bad', fetchImpl });

    await expect(provider.generateImage(makeInput())).rejects.toThrow(/status 401/);
  });

  it('throws a clear error when fetch itself rejects', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('network down'));
    const provider = new OpenAIImageGenerationProvider({
      apiKey: 'sk-test',
      fetchImpl,
      maxRetries: 0,
    });

    await expect(provider.generateImage(makeInput())).rejects.toThrow(
      /OpenAI request failed due to a network error/,
    );
  });

  it('throws a clear error when the response is missing b64_json data', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ data: [{}] }),
      text: async () => '',
    });
    const provider = new OpenAIImageGenerationProvider({ apiKey: 'sk-test', fetchImpl });

    await expect(provider.generateImage(makeInput())).rejects.toThrow(/b64_json/);
  });

  it('throws an ImageGenerationProviderError when the request times out', async () => {
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
      const provider = new OpenAIImageGenerationProvider({
        apiKey: 'sk-test',
        fetchImpl,
        timeoutMs: 50,
        maxRetries: 0,
        timeoutMaxRetries: 0,
      });

      const promise = provider.generateImage(makeInput());
      const assertion = expect(promise).rejects.toThrow(ImageGenerationProviderError);
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
          json: async () => ({ data: [{ b64_json: TINY_PNG_BASE64 }] }),
          text: async () => '',
        });
      const provider = new OpenAIImageGenerationProvider({
        apiKey: 'sk-test',
        fetchImpl,
        maxRetries: 1,
        timeoutMs: 5000,
        rateLimiter: new OpenAIImageRateLimiter({
          minIntervalMs: 0,
          maxRetries: 1,
          retryBaseMs: 10,
          retryMaxMs: 10,
        }),
      });

      const promise = provider.generateImage(makeInput());
      await vi.advanceTimersByTimeAsync(1000);
      const result = await promise;

      expect(fetchImpl).toHaveBeenCalledTimes(2);
      expect(result.contentType).toBe('image/png');
    } finally {
      vi.useRealTimers();
    }
  });

  it('falls back to the existing error/placeholder behavior once rate-limit retries are exhausted', async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = vi.fn().mockResolvedValue({
        ok: false,
        status: 429,
        json: async () => ({}),
        text: async () => 'rate limited',
      });
      const provider = new OpenAIImageGenerationProvider({
        apiKey: 'sk-test',
        fetchImpl,
        rateLimiter: new OpenAIImageRateLimiter({
          minIntervalMs: 0,
          maxRetries: 2,
          retryBaseMs: 10,
          retryMaxMs: 10,
        }),
      });

      const promise = provider.generateImage(makeInput());
      const assertion = expect(promise).rejects.toThrow(/status 429/);
      await vi.advanceTimersByTimeAsync(1000);
      await assertion;

      expect(fetchImpl).toHaveBeenCalledTimes(3); // 1 initial attempt + 2 retries
    } finally {
      vi.useRealTimers();
    }
  });

  it('shares one rate limiter across character-sheet and page-image requests', async () => {
    const fetchImpl = makeFetchOk();
    const rateLimiter = new OpenAIImageRateLimiter({ minIntervalMs: 0 });
    const scheduleSpy = vi.spyOn(rateLimiter, 'schedule');
    const provider = new OpenAIImageGenerationProvider({
      apiKey: 'sk-test',
      fetchImpl,
      rateLimiter,
    });

    await provider.generateCharacterSheet({
      bookId: 'b-1',
      characterProfile: makeCharacterProfile(),
    });
    await provider.generateImage(makeInput());

    expect(scheduleSpy).toHaveBeenCalledTimes(2);
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
          json: async () => ({ data: [{ b64_json: TINY_PNG_BASE64 }] }),
          text: async () => '',
        });
      const provider = new OpenAIImageGenerationProvider({
        apiKey: 'sk-test',
        fetchImpl,
        maxRetries: 1,
        timeoutMs: 5000,
      });

      const promise = provider.generateImage(makeInput());
      await vi.advanceTimersByTimeAsync(5000);
      const result = await promise;

      expect(fetchImpl).toHaveBeenCalledTimes(2);
      expect(result.buffer.length).toBeGreaterThan(0);
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
    const provider = new OpenAIImageGenerationProvider({
      apiKey: 'sk-test',
      fetchImpl,
      maxRetries: 2,
    });

    await expect(provider.generateImage(makeInput())).rejects.toThrow(/status 400/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('does not retry on HTTP 401', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({}),
      text: async () => 'invalid api key',
    });
    const provider = new OpenAIImageGenerationProvider({
      apiKey: 'sk-test',
      fetchImpl,
      maxRetries: 2,
    });

    await expect(provider.generateImage(makeInput())).rejects.toThrow(/status 401/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('does not leak the API key in a thrown error message', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('network down'));
    const provider = new OpenAIImageGenerationProvider({
      apiKey: 'sk-super-secret-key',
      fetchImpl,
      maxRetries: 0,
    });

    try {
      await provider.generateImage(makeInput());
      throw new Error('expected generateImage to reject');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      expect(message).not.toContain('sk-super-secret-key');
    }
  });

  describe('structured failure details (OpenAIImageRequestError)', () => {
    it('retains the HTTP status, OpenAI error type, and OpenAI error code from a JSON error body', async () => {
      const fetchImpl = vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        json: async () => ({}),
        text: async () =>
          JSON.stringify({
            error: {
              message: 'Your request was rejected by the safety system.',
              type: 'invalid_request_error',
              code: 'content_policy_violation',
            },
          }),
      });
      const provider = new OpenAIImageGenerationProvider({ apiKey: 'sk-test', fetchImpl });

      const err = await provider
        .generateImage(makeInput())
        .catch((e) => e as OpenAIImageRequestError);

      expect(err).toBeInstanceOf(OpenAIImageRequestError);
      expect(err.details.httpStatus).toBe(400);
      expect(err.details.errorType).toBe('invalid_request_error');
      expect(err.details.errorCode).toBe('content_policy_violation');
      expect(err.message).toContain('status 400');
      expect(err.message).not.toContain('Your request was rejected by the safety system.');
    });

    it('never includes the raw response body verbatim when it is not valid JSON', async () => {
      const fetchImpl = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        json: async () => ({}),
        text: async () => 'not-json-and-possibly-unsafe-payload',
      });
      const provider = new OpenAIImageGenerationProvider({
        apiKey: 'sk-test',
        fetchImpl,
        maxRetries: 0,
      });

      const err = await provider
        .generateImage(makeInput())
        .catch((e) => e as OpenAIImageRequestError);

      expect(err.details.httpStatus).toBe(500);
      expect(err.details.errorType).toBeUndefined();
      expect(err.details.errorCode).toBeUndefined();
      expect(err.message).not.toContain('not-json-and-possibly-unsafe-payload');
    });

    it('records the attempt count and limiter retry stats when rate-limit retries are exhausted', async () => {
      vi.useFakeTimers();
      try {
        const fetchImpl = vi.fn().mockResolvedValue({
          ok: false,
          status: 429,
          json: async () => ({}),
          text: async () => '',
        });
        const provider = new OpenAIImageGenerationProvider({
          apiKey: 'sk-test',
          fetchImpl,
          rateLimiter: new OpenAIImageRateLimiter({
            minIntervalMs: 0,
            maxRetries: 2,
            retryBaseMs: 10,
            retryMaxMs: 10,
          }),
        });

        const promise = provider.generateImage(makeInput());
        const errPromise = promise.catch((e) => e as OpenAIImageRequestError);
        await vi.advanceTimersByTimeAsync(1000);
        const err = await errPromise;

        expect(err.details.httpStatus).toBe(429);
        expect(err.details.attempts).toBe(3); // 1 initial + 2 retries
        expect(err.details.limiterRetries).toBe(2);
        expect(err.details.limiterWaitMs).toBeGreaterThan(0);
      } finally {
        vi.useRealTimers();
      }
    });

    it('reports requestMode=character-reference-edit and characterReferenceSupplied=true when the failed request carried a reference', async () => {
      const fetchImpl = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        json: async () => ({}),
        text: async () => '',
      });
      const provider = new OpenAIImageGenerationProvider({
        apiKey: 'sk-test',
        fetchImpl,
        maxRetries: 0,
      });

      const err = await provider
        .generateImage(makeInput({ characterReference: makeReference() }))
        .catch((e) => e as OpenAIImageRequestError);

      expect(err.details.requestMode).toBe('character-reference-edit');
      expect(err.details.characterReferenceSupplied).toBe(true);
    });

    it('reports requestMode=text-to-image and characterReferenceSupplied=false when the failed request carried no reference', async () => {
      const fetchImpl = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        json: async () => ({}),
        text: async () => '',
      });
      const provider = new OpenAIImageGenerationProvider({
        apiKey: 'sk-test',
        fetchImpl,
        maxRetries: 0,
      });

      const err = await provider
        .generateImage(makeInput())
        .catch((e) => e as OpenAIImageRequestError);

      expect(err.details.requestMode).toBe('text-to-image');
      expect(err.details.characterReferenceSupplied).toBe(false);
    });

    it('never leaks the API key via the structured error details or message on a network failure', async () => {
      const fetchImpl = vi.fn().mockRejectedValue(new Error('network down'));
      const provider = new OpenAIImageGenerationProvider({
        apiKey: 'sk-super-secret-key',
        fetchImpl,
        maxRetries: 0,
      });

      const err = await provider
        .generateImage(makeInput())
        .catch((e) => e as OpenAIImageRequestError);

      expect(err).toBeInstanceOf(OpenAIImageRequestError);
      expect(err.details.httpStatus).toBeUndefined();
      expect(JSON.stringify(err.details)).not.toContain('sk-super-secret-key');
    });
  });

  describe('generateImage with a character reference', () => {
    it('uses /images/edits instead of /images/generations when a reference image is provided', async () => {
      const fetchImpl = makeFetchOk();
      const provider = new OpenAIImageGenerationProvider({
        apiKey: 'sk-test',
        baseUrl: 'https://example.test/v1',
        fetchImpl,
      });

      await provider.generateImage(makeInput({ characterReference: makeReference() }));

      expect(fetchImpl).toHaveBeenCalledWith(
        'https://example.test/v1/images/edits',
        expect.anything(),
      );
    });

    it('uses /images/generations when no reference image is provided (unchanged behavior)', async () => {
      const fetchImpl = makeFetchOk();
      const provider = new OpenAIImageGenerationProvider({
        apiKey: 'sk-test',
        baseUrl: 'https://example.test/v1',
        fetchImpl,
      });

      await provider.generateImage(makeInput());

      expect(fetchImpl).toHaveBeenCalledWith(
        'https://example.test/v1/images/generations',
        expect.anything(),
      );
    });

    it('sends the request as multipart/form-data via the native FormData body', async () => {
      const fetchImpl = makeFetchOk();
      const provider = new OpenAIImageGenerationProvider({ apiKey: 'sk-test', fetchImpl });

      await provider.generateImage(makeInput({ characterReference: makeReference() }));

      const init = fetchImpl.mock.calls[0]![1] as RequestInit;
      expect(init.body).toBeInstanceOf(FormData);
    });

    it('does not manually set a Content-Type header, leaving the fetch runtime to add the multipart boundary', async () => {
      const fetchImpl = makeFetchOk();
      const provider = new OpenAIImageGenerationProvider({ apiKey: 'sk-test', fetchImpl });

      await provider.generateImage(makeInput({ characterReference: makeReference() }));

      const init = fetchImpl.mock.calls[0]![1] as RequestInit;
      const headers = init.headers as Record<string, string>;
      expect(Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')).toBe(false);
    });

    it('includes the Authorization header', async () => {
      const fetchImpl = makeFetchOk();
      const provider = new OpenAIImageGenerationProvider({ apiKey: 'sk-test', fetchImpl });

      await provider.generateImage(makeInput({ characterReference: makeReference() }));

      const init = fetchImpl.mock.calls[0]![1] as RequestInit;
      const headers = init.headers as Record<string, string>;
      expect(headers['Authorization']).toBe('Bearer sk-test');
    });

    it('includes model, prompt, size, n=1, and the reference image bytes in the form data', async () => {
      const fetchImpl = makeFetchOk();
      const provider = new OpenAIImageGenerationProvider({
        apiKey: 'sk-test',
        model: 'gpt-image-test',
        fetchImpl,
      });
      const reference = makeReference({ buffer: Buffer.from('reference-bytes-here') });

      await provider.generateImage(makeInput({ characterReference: reference }));

      const form = (fetchImpl.mock.calls[0]![1] as RequestInit).body as FormData;
      expect(form.get('model')).toBe('gpt-image-test');
      expect(form.get('n')).toBe('1');
      expect(typeof form.get('prompt')).toBe('string');
      expect(form.get('prompt') as string).toContain('Mia');
      expect(form.get('prompt') as string).toMatch(/attached character reference sheet/i);
      const imageField = form.get('image') as Blob;
      expect(imageField).toBeInstanceOf(Blob);
      expect(imageField.size).toBe(reference.buffer.length);
    });

    it('requests high input fidelity for the default gpt-image model', async () => {
      const fetchImpl = makeFetchOk();
      const provider = new OpenAIImageGenerationProvider({ apiKey: 'sk-test', fetchImpl });

      await provider.generateImage(makeInput({ characterReference: makeReference() }));

      const form = (fetchImpl.mock.calls[0]![1] as RequestInit).body as FormData;
      expect(form.get('input_fidelity')).toBe('high');
    });

    it('omits input_fidelity for a non-gpt-image model', async () => {
      const fetchImpl = makeFetchOk();
      const provider = new OpenAIImageGenerationProvider({
        apiKey: 'sk-test',
        model: 'some-other-model',
        fetchImpl,
      });

      await provider.generateImage(makeInput({ characterReference: makeReference() }));

      const form = (fetchImpl.mock.calls[0]![1] as RequestInit).body as FormData;
      expect(form.get('input_fidelity')).toBeNull();
    });

    it('maps landscape/portrait/square entry dimensions to the correct size field, same as the text-to-image path', async () => {
      const fetchImpl = makeFetchOk();
      const provider = new OpenAIImageGenerationProvider({ apiKey: 'sk-test', fetchImpl });

      await provider.generateImage(
        makeInput({
          entry: makeEntry({ width: 1536, height: 1024 }),
          characterReference: makeReference(),
        }),
      );
      await provider.generateImage(
        makeInput({
          entry: makeEntry({ width: 1024, height: 1536 }),
          characterReference: makeReference(),
        }),
      );
      await provider.generateImage(
        makeInput({
          entry: makeEntry({ width: 1024, height: 1024 }),
          characterReference: makeReference(),
        }),
      );

      const sizes = fetchImpl.mock.calls.map(
        (call) => ((call[1] as RequestInit).body as FormData).get('size') as string,
      );
      expect(sizes).toEqual(['1536x1024', '1024x1536', '1024x1024']);
    });

    it('maps a successful base64 response to the ImageGenerationOutput shape with usedReference=true', async () => {
      const fetchImpl = makeFetchOk();
      const provider = new OpenAIImageGenerationProvider({ apiKey: 'sk-test', fetchImpl });

      const result = await provider.generateImage(
        makeInput({ characterReference: makeReference() }),
      );

      expect(Buffer.isBuffer(result.buffer)).toBe(true);
      expect(result.buffer.equals(Buffer.from(TINY_PNG_BASE64, 'base64'))).toBe(true);
      expect(result.contentType).toBe('image/png');
      expect(result.usedReference).toBe(true);
    });

    it('does not set usedReference when no reference image is provided', async () => {
      const fetchImpl = makeFetchOk();
      const provider = new OpenAIImageGenerationProvider({ apiKey: 'sk-test', fetchImpl });

      const result = await provider.generateImage(makeInput());

      expect(result.usedReference).toBeUndefined();
    });

    it('throws a clear error when the edit response is missing b64_json data', async () => {
      const fetchImpl = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ data: [{}] }),
        text: async () => '',
      });
      const provider = new OpenAIImageGenerationProvider({ apiKey: 'sk-test', fetchImpl });

      await expect(
        provider.generateImage(makeInput({ characterReference: makeReference() })),
      ).rejects.toThrow(/b64_json/);
    });

    it('throws a clear error when the edit HTTP response is not ok', async () => {
      const fetchImpl = vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        json: async () => ({}),
        text: async () => 'bad request',
      });
      const provider = new OpenAIImageGenerationProvider({
        apiKey: 'sk-test',
        fetchImpl,
        maxRetries: 0,
      });

      await expect(
        provider.generateImage(makeInput({ characterReference: makeReference() })),
      ).rejects.toThrow(/status 400/);
    });

    it('retries the edit request on HTTP 500 and succeeds on the second attempt', async () => {
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
            json: async () => ({ data: [{ b64_json: TINY_PNG_BASE64 }] }),
            text: async () => '',
          });
        const provider = new OpenAIImageGenerationProvider({
          apiKey: 'sk-test',
          fetchImpl,
          maxRetries: 1,
          timeoutMs: 5000,
        });

        const promise = provider.generateImage(makeInput({ characterReference: makeReference() }));
        await vi.advanceTimersByTimeAsync(5000);
        const result = await promise;

        expect(fetchImpl).toHaveBeenCalledTimes(2);
        expect(result.usedReference).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });

    it('throws an ImageGenerationProviderError when the edit request times out', async () => {
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
        const provider = new OpenAIImageGenerationProvider({
          apiKey: 'sk-test',
          fetchImpl,
          timeoutMs: 50,
          maxRetries: 0,
          timeoutMaxRetries: 0,
        });

        const promise = provider.generateImage(makeInput({ characterReference: makeReference() }));
        const assertion = expect(promise).rejects.toThrow(ImageGenerationProviderError);
        await vi.advanceTimersByTimeAsync(50);
        await assertion;
      } finally {
        vi.useRealTimers();
      }
    });

    it('never logs the reference image bytes or resulting base64 output', async () => {
      const fetchImpl = makeFetchOk();
      const logSpy = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
      const provider = new OpenAIImageGenerationProvider({ apiKey: 'sk-test', fetchImpl });
      const reference = makeReference({ buffer: Buffer.from('super-secret-reference-bytes') });

      await provider.generateImage(makeInput({ characterReference: reference }));

      const loggedText = logSpy.mock.calls.flat().map(String).join('\n');
      expect(loggedText).not.toContain(reference.buffer.toString('base64'));
      expect(loggedText).not.toContain(TINY_PNG_BASE64);
      logSpy.mockRestore();
    });

    it('respects the REAL_GENERATION_MAX_PAGES guardrail before ever building the multipart request', async () => {
      const fetchImpl = makeFetchOk();
      const provider = new OpenAIImageGenerationProvider({
        apiKey: 'sk-test',
        fetchImpl,
        maxPages: 1,
      });

      await expect(
        provider.generateImage(
          makeInput({
            entry: makeEntry({ kind: 'page', pageNumber: 2 }),
            characterReference: makeReference(),
          }),
        ),
      ).rejects.toThrow(/REAL_GENERATION_MAX_PAGES/);
      expect(fetchImpl).not.toHaveBeenCalled();
    });
  });

  describe('generateCharacterSheet', () => {
    it('sends a portrait-sized request built from the character-sheet prompt', async () => {
      const fetchImpl = makeFetchOk();
      const provider = new OpenAIImageGenerationProvider({ apiKey: 'sk-test', fetchImpl });

      const result = await provider.generateCharacterSheet({
        bookId: 'b-1',
        characterProfile: makeCharacterProfile(),
      });

      const body = JSON.parse(fetchImpl.mock.calls[0]![1].body as string);
      expect(body.size).toBe('1024x1536');
      expect(body.prompt).toMatch(/full-body/i);
      expect(body.prompt).toContain('a bright yellow overall with sneakers');
      expect(result.contentType).toBe('image/png');
      expect(Buffer.isBuffer(result.buffer)).toBe(true);
    });

    it('throws a clear error when the HTTP response is not ok', async () => {
      const fetchImpl = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        json: async () => ({}),
        text: async () => 'server error',
      });
      const provider = new OpenAIImageGenerationProvider({
        apiKey: 'sk-test',
        fetchImpl,
        maxRetries: 0,
      });

      await expect(
        provider.generateCharacterSheet({
          bookId: 'b-1',
          characterProfile: makeCharacterProfile(),
        }),
      ).rejects.toThrow(/status 500/);
    });
  });

  describe('REAL_GENERATION_MAX_PAGES guardrail', () => {
    it('rejects a page entry above the configured maxPages without calling fetch', async () => {
      const fetchImpl = makeFetchOk();
      const provider = new OpenAIImageGenerationProvider({
        apiKey: 'sk-test',
        fetchImpl,
        maxPages: 12,
      });

      const input = makeInput({
        entry: makeEntry({ kind: 'page', pageNumber: 13 }),
      });

      await expect(provider.generateImage(input)).rejects.toThrow(/REAL_GENERATION_MAX_PAGES/);
      expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('allows a page entry at or below the configured maxPages', async () => {
      const fetchImpl = makeFetchOk();
      const provider = new OpenAIImageGenerationProvider({
        apiKey: 'sk-test',
        fetchImpl,
        maxPages: 12,
      });

      const input = makeInput({
        entry: makeEntry({ kind: 'page', pageNumber: 12 }),
      });

      await expect(provider.generateImage(input)).resolves.toBeDefined();
    });

    it('does not apply the page cap to cover/back_cover entries', async () => {
      const fetchImpl = makeFetchOk();
      const provider = new OpenAIImageGenerationProvider({
        apiKey: 'sk-test',
        fetchImpl,
        maxPages: 1,
      });

      const input = makeInput({ entry: makeEntry({ kind: 'cover', pageNumber: undefined }) });

      await expect(provider.generateImage(input)).resolves.toBeDefined();
    });
  });

  describe('configurable image request timeout', () => {
    it('defaults the request timeout to DEFAULT_OPENAI_IMAGE_REQUEST_TIMEOUT_MS when not configured', async () => {
      vi.useFakeTimers();
      try {
        const fetchImpl = makeAbortableFetch();
        const provider = new OpenAIImageGenerationProvider({
          apiKey: 'sk-test',
          fetchImpl,
          timeoutMaxRetries: 0,
        });

        const promise = provider.generateImage(makeInput());
        const assertion = expect(promise).rejects.toThrow(/OpenAI request timed out/);
        await vi.advanceTimersByTimeAsync(DEFAULT_OPENAI_IMAGE_REQUEST_TIMEOUT_MS);
        await assertion;
      } finally {
        vi.useRealTimers();
      }
    });

    it('accepts a slow success well past the old 60s default but below the configured timeout', async () => {
      vi.useFakeTimers();
      try {
        const fetchImpl = vi.fn(() => {
          return new Promise((resolve) => {
            setTimeout(
              () =>
                resolve({
                  ok: true,
                  status: 200,
                  json: async () => ({ data: [{ b64_json: TINY_PNG_BASE64 }] }),
                  text: async () => '',
                }),
              100_000,
            );
          });
        });
        const provider = new OpenAIImageGenerationProvider({ apiKey: 'sk-test', fetchImpl });

        const promise = provider.generateImage(makeInput());
        await vi.advanceTimersByTimeAsync(100_000);
        const result = await promise;

        expect(result.contentType).toBe('image/png');
      } finally {
        vi.useRealTimers();
      }
    });

    it('aborts a request that exceeds the configured timeout', async () => {
      vi.useFakeTimers();
      try {
        const fetchImpl = makeAbortableFetch();
        const provider = new OpenAIImageGenerationProvider({
          apiKey: 'sk-test',
          fetchImpl,
          timeoutMs: 5000,
          timeoutMaxRetries: 0,
        });

        const promise = provider.generateImage(makeInput());
        const assertion = expect(promise).rejects.toThrow(/OpenAI request timed out/);
        await vi.advanceTimersByTimeAsync(5000);
        await assertion;
      } finally {
        vi.useRealTimers();
      }
    });

    it('makes at most two total attempts by default when every attempt times out (1 initial + 1 retry)', async () => {
      vi.useFakeTimers();
      try {
        const fetchImpl = makeAbortableFetch();
        const provider = new OpenAIImageGenerationProvider({
          apiKey: 'sk-test',
          fetchImpl,
          timeoutMs: 1000,
        });

        const promise = provider.generateImage(makeInput());
        const assertion = expect(promise).rejects.toThrow(ImageGenerationProviderError);
        await vi.advanceTimersByTimeAsync(5000);
        await assertion;

        expect(fetchImpl).toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
      }
    });

    it('keeps maxRetries (network/5xx) independent from timeoutMaxRetries', async () => {
      vi.useFakeTimers();
      try {
        const fetchImpl = makeAbortableFetch();
        const provider = new OpenAIImageGenerationProvider({
          apiKey: 'sk-test',
          fetchImpl,
          timeoutMs: 1000,
          maxRetries: 5,
          timeoutMaxRetries: 1,
        });

        const promise = provider.generateImage(makeInput());
        const assertion = expect(promise).rejects.toThrow(ImageGenerationProviderError);
        await vi.advanceTimersByTimeAsync(10_000);
        await assertion;

        // Bounded by timeoutMaxRetries=1, not the much larger maxRetries=5.
        expect(fetchImpl).toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
      }
    });

    it('does not let the rate-limiter spacing wait count against the request timeout', async () => {
      vi.useFakeTimers();
      try {
        const fetchImpl = makeFetchOk();
        const rateLimiter = new OpenAIImageRateLimiter({ minIntervalMs: 5000 });
        const provider = new OpenAIImageGenerationProvider({
          apiKey: 'sk-test',
          fetchImpl,
          timeoutMs: 1000, // shorter than the 5s spacing wait between requests
          rateLimiter,
        });

        const first = provider.generateImage(makeInput());
        await vi.advanceTimersByTimeAsync(0);
        await first;

        // The second call must wait ~5000ms for rate-limiter spacing before
        // its own 1000ms request timeout even starts — if the spacing wait
        // counted against the timeout, this would abort instead of succeeding.
        const second = provider.generateImage(makeInput());
        await vi.advanceTimersByTimeAsync(6000);
        await expect(second).resolves.toBeDefined();
      } finally {
        vi.useRealTimers();
      }
    });

    it('exposes errorCode=request_timeout, timeoutMs, elapsedMs, and a retryDecision when every attempt times out', async () => {
      vi.useFakeTimers();
      try {
        const fetchImpl = makeAbortableFetch();
        const provider = new OpenAIImageGenerationProvider({
          apiKey: 'sk-test',
          fetchImpl,
          timeoutMs: 1000,
          timeoutMaxRetries: 0,
        });

        const promise = provider.generateImage(makeInput());
        const errPromise = promise.catch((e) => e as OpenAIImageRequestError);
        await vi.advanceTimersByTimeAsync(1000);
        const err = await errPromise;

        expect(err.details.errorCode).toBe('request_timeout');
        expect(err.details.timeoutMs).toBe(1000);
        expect(err.details.elapsedMs).toBeGreaterThanOrEqual(1000);
        expect(typeof err.details.retryDecision).toBe('string');
      } finally {
        vi.useRealTimers();
      }
    });

    it('does not set errorCode=request_timeout for a plain network failure', async () => {
      const fetchImpl = vi.fn().mockRejectedValue(new Error('network down'));
      const provider = new OpenAIImageGenerationProvider({
        apiKey: 'sk-test',
        fetchImpl,
        maxRetries: 0,
      });

      const err = await provider
        .generateImage(makeInput())
        .catch((e) => e as OpenAIImageRequestError);

      expect(err.details.errorCode).toBeUndefined();
      expect(err.details.timeoutMs).toBeUndefined();
      expect(err.details.elapsedMs).toBeUndefined();
    });

    it('never leaks the API key via timeout failure details', async () => {
      vi.useFakeTimers();
      try {
        const fetchImpl = makeAbortableFetch();
        const provider = new OpenAIImageGenerationProvider({
          apiKey: 'sk-super-secret-key',
          fetchImpl,
          timeoutMs: 1000,
          timeoutMaxRetries: 0,
        });

        const promise = provider.generateImage(makeInput());
        const errPromise = promise.catch((e) => e as OpenAIImageRequestError);
        await vi.advanceTimersByTimeAsync(1000);
        const err = await errPromise;

        expect(JSON.stringify(err.details)).not.toContain('sk-super-secret-key');
      } finally {
        vi.useRealTimers();
      }
    });

    it('the character-reference-edit flow still reports request_timeout diagnostics on timeout', async () => {
      vi.useFakeTimers();
      try {
        const fetchImpl = makeAbortableFetch();
        const provider = new OpenAIImageGenerationProvider({
          apiKey: 'sk-test',
          fetchImpl,
          timeoutMs: 1000,
          timeoutMaxRetries: 0,
        });

        const promise = provider.generateImage(makeInput({ characterReference: makeReference() }));
        const errPromise = promise.catch((e) => e as OpenAIImageRequestError);
        await vi.advanceTimersByTimeAsync(1000);
        const err = await errPromise;

        expect(err.details.errorCode).toBe('request_timeout');
        expect(err.details.requestMode).toBe('character-reference-edit');
        expect(err.details.characterReferenceSupplied).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
