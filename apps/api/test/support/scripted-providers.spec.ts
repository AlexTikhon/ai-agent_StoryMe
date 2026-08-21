import { describe, expect, it } from 'vitest';
import { MockCharacterProfileProvider } from '../../src/agent/character-profile-provider';
import { GenerationProviderTelemetry } from '../../src/agent/generation-provider-telemetry';
import {
  classifyProviderFailure,
  ProviderCancellationError,
  safeProviderFailureMessage,
} from '../../src/common/provider-execution';
import { failThenSucceed, ScriptedStoryProvider } from './scripted-providers';

async function storyInput() {
  const characterProfile = await new MockCharacterProfileProvider().buildProfile({
    bookId: 'book-1',
    childName: 'Mia',
    childAge: 5,
    theme: 'friendship',
    language: 'en',
  });
  return {
    bookId: 'book-1',
    childName: 'Mia',
    childAge: 5,
    theme: 'friendship',
    language: 'en',
    pageCount: 6,
    characterProfile,
  };
}

describe('scripted local providers', () => {
  it.each(['rate_limit', 'network_error'] as const)(
    'retries one %s HTTP failure inside one logical invocation',
    async (failure) => {
      const provider = new ScriptedStoryProvider(failThenSucceed(failure));
      const telemetry = new GenerationProviderTelemetry(17, 0, {});
      const input = await storyInput();

      await telemetry.record({
        operation: 'story',
        provider: 'mock',
        model: provider.modelName,
        promptVersion: provider.promptVersion,
        promptInput: input,
        execute: (options) => provider.generateStory(input, options),
      });

      expect(provider.stats).toMatchObject({
        logicalCalls: 1,
        httpAttempts: 2,
        retries: 1,
      });
      expect(telemetry.snapshot().calls).toEqual([
        expect.objectContaining({
          operation: 'story',
          attempt: 1,
          status: 'success',
          httpAttempts: 2,
          retries: 1,
          ...(failure === 'rate_limit' && { rateLimitHits: 1 }),
        }),
      ]);
    },
  );

  it('classifies a permanent invalid response without exposing its private payload', async () => {
    const privateMessage = 'raw prompt=child-secret Authorization=Bearer sk-test';
    const provider = new ScriptedStoryProvider([{ result: 'invalid_response', privateMessage }]);

    let failure: unknown;
    try {
      await provider.generateStory(await storyInput());
    } catch (error) {
      failure = error;
    }

    expect(classifyProviderFailure(failure)).toBe('invalid_response');
    expect(safeProviderFailureMessage(failure)).toBe('Provider returned an invalid response.');
    expect(safeProviderFailureMessage(failure)).not.toContain('child-secret');
    expect(provider.stats).toMatchObject({ logicalCalls: 1, httpAttempts: 1, retries: 0 });
  });

  it('uses AbortSignal to stop a delayed provider without beginning an HTTP attempt', async () => {
    const provider = new ScriptedStoryProvider([
      { result: 'delay', delayMs: 10_000 },
      { result: 'success' },
    ]);
    const controller = new AbortController();
    const pending = provider.generateStory(await storyInput(), { signal: controller.signal });

    controller.abort('cancel-test');

    await expect(pending).rejects.toBeInstanceOf(ProviderCancellationError);
    expect(provider.stats).toMatchObject({ logicalCalls: 1, httpAttempts: 0 });
  });

  it('counts story and repair as two logical calls while a transient repair retry uses three HTTP attempts', async () => {
    const base = new (
      await import('../../src/agent/story-generation-provider')
    ).MockStoryGenerationProvider();
    const delegate = {
      generateStory: (input: Awaited<ReturnType<typeof storyInput>>) => base.generateStory(input),
      repairStory: async (input: { candidate: Awaited<ReturnType<typeof base.generateStory>> }) =>
        input.candidate,
    };
    const provider = new ScriptedStoryProvider(
      [{ result: 'success' }, ...failThenSucceed('network_error')],
      delegate,
    );
    const telemetry = new GenerationProviderTelemetry(2, 2, {});
    const input = await storyInput();
    const story = await telemetry.record({
      operation: 'story',
      provider: 'openai',
      promptVersion: provider.promptVersion,
      promptInput: input,
      execute: (options) => provider.generateStory(input, options),
    });
    await telemetry.record({
      operation: 'story_repair',
      provider: 'openai',
      promptVersion: provider.promptVersion,
      promptInput: { candidate: story },
      execute: (options) =>
        provider.repairStory!(
          { generationInput: input, candidate: story, qualityReport: {} as never },
          options,
        ),
    });

    const snapshot = telemetry.snapshot();
    expect(snapshot).toMatchObject({ plannedPaidCalls: 2, actualPaidCalls: 2 });
    expect(snapshot.calls).toHaveLength(2);
    expect(snapshot.calls.map((call) => call.httpAttempts)).toEqual([1, 2]);
    expect(provider.stats).toMatchObject({ logicalCalls: 2, httpAttempts: 3, retries: 1 });
  });
});
