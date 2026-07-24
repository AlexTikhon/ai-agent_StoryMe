import { describe, expect, it, vi } from 'vitest';
import type { StoryGenerationProvider } from './story-generation-provider';
import { GenerationProviderTelemetry } from './generation-provider-telemetry';
import { StoryContentStage } from './story-content.stage';

describe('StoryContentStage', () => {
  it('performs one provider call and rejects an invalid typed result', async () => {
    const result = {};
    const generateStory = vi.fn().mockResolvedValue(result);
    const provider = {
      providerName: 'mock',
      modelName: 'mock-story',
      promptVersion: 'test-v1',
      generateStory,
    } as unknown as StoryGenerationProvider;
    const stage = new StoryContentStage(provider);

    await expect(
      stage.execute({
        prompt: {
          bookId: 'book-1',
          childName: 'Alex',
          childAge: 6,
          theme: 'adventure',
          language: 'en',
          characterProfile: {} as never,
        },
        targetPageCount: 0,
        telemetry: new GenerationProviderTelemetry(10, 0),
      }),
    ).rejects.toThrow();
    expect(generateStory).toHaveBeenCalledTimes(1);
  });
});
