import { describe, it, expect } from 'vitest';
import { createCharacterProfileProvider } from './character-profile-provider.factory';
import { MockCharacterProfileProvider } from './character-profile-provider';
import { OpenAICharacterProfileProvider } from './openai-character-profile-provider';

describe('createCharacterProfileProvider', () => {
  it('defaults to MockCharacterProfileProvider when CHARACTER_PROFILE_PROVIDER is unset', () => {
    const provider = createCharacterProfileProvider({} as NodeJS.ProcessEnv);
    expect(provider).toBeInstanceOf(MockCharacterProfileProvider);
  });

  it('defaults to MockCharacterProfileProvider when CHARACTER_PROFILE_PROVIDER is empty', () => {
    const provider = createCharacterProfileProvider({
      CHARACTER_PROFILE_PROVIDER: '',
    } as unknown as NodeJS.ProcessEnv);
    expect(provider).toBeInstanceOf(MockCharacterProfileProvider);
  });

  it('returns MockCharacterProfileProvider when explicitly set to "mock"', () => {
    const provider = createCharacterProfileProvider({
      CHARACTER_PROFILE_PROVIDER: 'mock',
    } as unknown as NodeJS.ProcessEnv);
    expect(provider).toBeInstanceOf(MockCharacterProfileProvider);
  });

  it('is case-insensitive for the provider name', () => {
    const provider = createCharacterProfileProvider({
      CHARACTER_PROFILE_PROVIDER: 'MOCK',
    } as unknown as NodeJS.ProcessEnv);
    expect(provider).toBeInstanceOf(MockCharacterProfileProvider);
  });

  it('throws a clear error when selecting openai without OPENAI_API_KEY', () => {
    expect(() =>
      createCharacterProfileProvider({
        CHARACTER_PROFILE_PROVIDER: 'openai',
      } as unknown as NodeJS.ProcessEnv),
    ).toThrow(/OPENAI_API_KEY/);
  });

  it('returns OpenAICharacterProfileProvider when selected with an API key', () => {
    const provider = createCharacterProfileProvider({
      CHARACTER_PROFILE_PROVIDER: 'openai',
      OPENAI_API_KEY: 'sk-test-key',
    } as unknown as NodeJS.ProcessEnv);
    expect(provider).toBeInstanceOf(OpenAICharacterProfileProvider);
  });

  it('is independent of STORY_GENERATION_PROVIDER/IMAGE_GENERATION_PROVIDER', () => {
    const provider = createCharacterProfileProvider({
      STORY_GENERATION_PROVIDER: 'openai',
      IMAGE_GENERATION_PROVIDER: 'openai',
      OPENAI_API_KEY: 'sk-test-key',
    } as unknown as NodeJS.ProcessEnv);
    expect(provider).toBeInstanceOf(MockCharacterProfileProvider);
  });

  it('throws a clear error for an unknown provider name', () => {
    expect(() =>
      createCharacterProfileProvider({
        CHARACTER_PROFILE_PROVIDER: 'anthropic',
      } as unknown as NodeJS.ProcessEnv),
    ).toThrow(/Unknown CHARACTER_PROFILE_PROVIDER/);
  });
});
