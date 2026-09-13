import { describe, expect, it } from 'vitest';
import {
  GenerationProviderTelemetry,
  PaidProviderCallBudgetError,
  hashProviderPrompt,
  requiredPaidProviderCallsForBook,
} from './generation-provider-telemetry';
import { ProviderCancellationError } from '../common/provider-execution';

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
    expect(
      requiredPaidProviderCallsForBook(12, {
        storyProvider: 'openai',
        characterProfileProvider: 'openai',
        imageProvider: 'openai',
        storyRepairEnabled: true,
      }),
    ).toBe(18);
    expect(
      requiredPaidProviderCallsForBook(12, {
        storyProvider: 'mock',
        characterProfileProvider: 'openai',
        imageProvider: 'openai',
        storyRepairEnabled: true,
      }),
    ).toBe(16);
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
    ).rejects.toMatchObject({
      reason: 'provider_transient_failure',
      message: 'Provider request failed.',
    });

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
      failureReason: 'provider_transient_failure',
    });
    expect(snapshot.calls.every((call) => /^[a-f0-9]{64}$/.test(call.promptHash))).toBe(true);
    expect(JSON.stringify(snapshot)).not.toContain('safe fingerprint input');
  });

  it('captures optional metrics without fabricating absent values', async () => {
    const telemetry = new GenerationProviderTelemetry(3, 1);
    await telemetry.record({
      operation: 'story',
      provider: 'openai',
      promptVersion: 'story-v1',
      promptInput: {},
      execute: async (options) => {
        options.onMetrics?.({
          inputTokens: 41,
          outputTokens: 17,
          httpAttempts: 2,
          retries: 1,
        });
        return 'ok';
      },
    });
    await telemetry.record({
      operation: 'character_profile',
      provider: 'mock',
      promptVersion: 'mock-v1',
      promptInput: {},
      execute: async () => 'ok',
    });

    expect(telemetry.snapshot().calls[0]).toMatchObject({
      inputTokens: 41,
      outputTokens: 17,
      httpAttempts: 2,
      retries: 1,
    });
    expect(telemetry.snapshot().calls[1]).not.toHaveProperty('inputTokens');
    expect(telemetry.snapshot().calls[1]).not.toHaveProperty('outputTokens');
  });

  it.each([
    [
      'timeout',
      'provider_transient_failure',
      Object.assign(new Error('safe timeout'), { failureKind: 'timeout' }),
    ],
    [
      'rate_limit',
      'provider_transient_failure',
      Object.assign(new Error('safe 429'), { failureKind: 'rate_limit' }),
    ],
    ['refusal', 'refusal', Object.assign(new Error('safe refusal'), { failureKind: 'refusal' })],
    [
      'schema_error',
      'invalid_output',
      Object.assign(new Error('safe schema'), { failureKind: 'schema_error' }),
    ],
    ['provider_error', 'provider_transient_failure', new Error('safe provider failure')],
  ] as const)('classifies %s failures', async (failureKind, failureReason, error) => {
    const telemetry = new GenerationProviderTelemetry(2, 1);
    await expect(
      telemetry.record({
        operation: 'story',
        provider: 'openai',
        promptVersion: 'story-v1',
        promptInput: {},
        execute: async () => {
          throw error;
        },
      }),
    ).rejects.toThrow();
    expect(telemetry.snapshot().calls[0]).toMatchObject({
      status: 'error',
      failureKind,
      failureReason,
    });
  });

  it('records cancellation as cancelled control flow, never an ordinary provider error', async () => {
    const telemetry = new GenerationProviderTelemetry(2, 1);
    await expect(
      telemetry.record({
        operation: 'story',
        provider: 'openai',
        promptVersion: 'story-v1',
        promptInput: {},
        execute: async () => {
          throw new ProviderCancellationError();
        },
      }),
    ).rejects.toBeInstanceOf(ProviderCancellationError);
    expect(telemetry.snapshot().calls[0]).toMatchObject({
      status: 'cancelled',
      failureKind: 'cancelled',
    });
  });
});
