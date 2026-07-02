import { describe, it, expect } from 'vitest';
import { checkPreconditions } from './smoke-real-generation-helpers';

describe('checkPreconditions', () => {
  it('requires OPENAI_API_KEY', () => {
    const message = checkPreconditions({} as NodeJS.ProcessEnv);
    expect(message).toMatch(/OPENAI_API_KEY/);
  });

  it('requires both providers to be "openai"', () => {
    const message = checkPreconditions({
      OPENAI_API_KEY: 'sk-test',
    } as unknown as NodeJS.ProcessEnv);
    expect(message).toMatch(/STORY_GENERATION_PROVIDER/);
    expect(message).toMatch(/IMAGE_GENERATION_PROVIDER_TOKEN/);
  });

  it('requires the image provider to be "openai" even if the story provider is', () => {
    const message = checkPreconditions({
      OPENAI_API_KEY: 'sk-test',
      STORY_GENERATION_PROVIDER: 'openai',
    } as unknown as NodeJS.ProcessEnv);
    expect(message).not.toBeNull();
  });

  it('returns null when every precondition is satisfied', () => {
    const message = checkPreconditions({
      OPENAI_API_KEY: 'sk-test',
      STORY_GENERATION_PROVIDER: 'openai',
      IMAGE_GENERATION_PROVIDER_TOKEN: 'openai',
    } as unknown as NodeJS.ProcessEnv);
    expect(message).toBeNull();
  });

  it('never includes the API key value in the returned message', () => {
    const message = checkPreconditions({
      OPENAI_API_KEY: 'sk-super-secret',
    } as unknown as NodeJS.ProcessEnv);
    expect(message).not.toContain('sk-super-secret');
  });
});
