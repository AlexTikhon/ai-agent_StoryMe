import { describe, it, expect } from 'vitest';
import { createImageGenerationProvider } from './image-generation-provider.factory';
import { MockImageGenerationProvider } from './image-generation-provider';
import { OpenAIImageGenerationProvider } from './openai-image-generation-provider';

describe('createImageGenerationProvider', () => {
  it('defaults to MockImageGenerationProvider when IMAGE_GENERATION_PROVIDER is unset', () => {
    const provider = createImageGenerationProvider({} as NodeJS.ProcessEnv);
    expect(provider).toBeInstanceOf(MockImageGenerationProvider);
  });

  it('defaults to MockImageGenerationProvider when IMAGE_GENERATION_PROVIDER is empty', () => {
    const provider = createImageGenerationProvider({
      IMAGE_GENERATION_PROVIDER: '',
    } as unknown as NodeJS.ProcessEnv);
    expect(provider).toBeInstanceOf(MockImageGenerationProvider);
  });

  it('returns MockImageGenerationProvider when explicitly set to "mock"', () => {
    const provider = createImageGenerationProvider({
      IMAGE_GENERATION_PROVIDER: 'mock',
    } as unknown as NodeJS.ProcessEnv);
    expect(provider).toBeInstanceOf(MockImageGenerationProvider);
  });

  it('is case-insensitive for the provider name', () => {
    const provider = createImageGenerationProvider({
      IMAGE_GENERATION_PROVIDER: 'MOCK',
    } as unknown as NodeJS.ProcessEnv);
    expect(provider).toBeInstanceOf(MockImageGenerationProvider);
  });

  it('throws a clear error when selecting openai without OPENAI_API_KEY', () => {
    expect(() =>
      createImageGenerationProvider({
        IMAGE_GENERATION_PROVIDER: 'openai',
      } as unknown as NodeJS.ProcessEnv),
    ).toThrow(/OPENAI_API_KEY/);
  });

  it('returns OpenAIImageGenerationProvider when selected with an API key', () => {
    const provider = createImageGenerationProvider({
      IMAGE_GENERATION_PROVIDER: 'openai',
      OPENAI_API_KEY: 'sk-test-key',
    } as unknown as NodeJS.ProcessEnv);
    expect(provider).toBeInstanceOf(OpenAIImageGenerationProvider);
  });

  it('wires a real shared rate limiter into the openai provider', () => {
    const provider = createImageGenerationProvider({
      IMAGE_GENERATION_PROVIDER: 'openai',
      OPENAI_API_KEY: 'sk-test-key',
    } as unknown as NodeJS.ProcessEnv) as OpenAIImageGenerationProvider;

    expect(provider.getRateLimitDiagnostics()).toEqual({
      requestsQueued: 0,
      totalWaitMs: 0,
      rateLimitHits: 0,
      retriesUsed: 0,
      retryAfterHonoredCount: 0,
    });
  });

  it('throws a clear error for an unknown provider name', () => {
    expect(() =>
      createImageGenerationProvider({
        IMAGE_GENERATION_PROVIDER: 'stability',
      } as unknown as NodeJS.ProcessEnv),
    ).toThrow(/Unknown IMAGE_GENERATION_PROVIDER/);
  });
});
