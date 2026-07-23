import { describe, expect, it } from 'vitest';
import {
  GenerationProviderTelemetry,
  PaidProviderCallBudgetError,
  hashProviderPrompt,
  requiredPaidProviderCallsForBook,
} from './generation-provider-telemetry';

describe('generation provider telemetry', () => {
  it('hashes normalized versioned inputs deterministically', () => {
    expect(hashProviderPrompt('v1', { b: 2, a: { d: 4, c: 3 } })).toBe(
      hashProviderPrompt('v1', { a: { c: 3, d: 4 }, b: 2 }),
    );
    expect(hashProviderPrompt('v2', { a: 1 })).not.toBe(hashProviderPrompt('v1', { a: 1 }));
  });

  it('plans the complete paid-call budget before generation', () => {
    expect(
      requiredPaidProviderCallsForBook(12, {
        storyProvider: 'openai',
        characterProfileProvider: 'openai',
        imageProvider: 'openai',
      }),
    ).toBe(17);
    expect(
      requiredPaidProviderCallsForBook(6, {
        storyProvider: 'mock',
        characterProfileProvider: 'mock',
        imageProvider: 'openai',
      }),
    ).toBe(9);
  });

  it('rejects a run whose complete plan exceeds its paid-call limit', () => {
    expect(() => new GenerationProviderTelemetry(10, 11)).toThrow(PaidProviderCallBudgetError);
  });

  it('reserves budget before concurrent provider calls begin', async () => {
    const telemetry = new GenerationProviderTelemetry(1, 1);
    const first = telemetry.record({
      operation: 'illustration',
      assetLabel: 'cover',
      provider: 'openai',
      promptVersion: 'image-v1',
      promptInput: {},
      execute: async () => 'ok',
    });
    const second = telemetry.record({
      operation: 'illustration',
      assetLabel: 'back_cover',
      provider: 'openai',
      promptVersion: 'image-v1',
      promptInput: {},
      execute: async () => 'unexpected',
    });
    const secondExpectation = expect(second).rejects.toThrow(PaidProviderCallBudgetError);

    await expect(first).resolves.toBe('ok');
    await secondExpectation;
  });

  it('records safe success/error metadata and configured cost estimates', async () => {
    const telemetry = new GenerationProviderTelemetry(3, 2, {
      OPENAI_STORY_ESTIMATED_COST_USD: '0.02',
      OPENAI_IMAGE_ESTIMATED_COST_USD: '0.04',
    });

    await telemetry.record({
      operation: 'story',
      provider: 'openai',
      model: 'story-model',
      promptVersion: 'story-v2',
      promptInput: { theme: 'forest' },
      execute: async () => 'ok',
    });
    await expect(
      telemetry.record({
        operation: 'illustration',
        assetLabel: 'cover',
        provider: 'openai',
        model: 'image-model',
        promptVersion: 'image-v3',
        promptInput: { prompt: 'safe fingerprint input' },
        execute: async () => {
          throw new Error('provider unavailable');
        },
      }),
    ).rejects.toThrow('provider unavailable');

    const snapshot = telemetry.snapshot();
    expect(snapshot).toMatchObject({
      maxPaidCalls: 3,
      plannedPaidCalls: 2,
      actualPaidCalls: 2,
      estimatedCostUsd: 0.06,
    });
    expect(snapshot.calls).toHaveLength(2);
    expect(snapshot.calls[0]).toMatchObject({
      callIndex: 1,
      operation: 'story',
      status: 'success',
      attempt: 1,
      estimatedCostUsd: 0.02,
    });
    expect(snapshot.calls[1]).toMatchObject({
      callIndex: 2,
      operation: 'illustration',
      assetLabel: 'cover',
      status: 'error',
      estimatedCostUsd: 0.04,
    });
    expect(snapshot.calls.every((call) => /^[a-f0-9]{64}$/.test(call.promptHash))).toBe(true);
    expect(JSON.stringify(snapshot)).not.toContain('safe fingerprint input');
  });
});
