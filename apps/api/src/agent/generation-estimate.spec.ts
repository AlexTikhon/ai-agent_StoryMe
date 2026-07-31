import { describe, expect, it } from 'vitest';
import {
  assertGenerationHardLimits,
  buildGenerationEstimate,
  GenerationHardBudgetError,
} from './generation-estimate';

const realProviders = {
  story: 'openai',
  characterProfile: 'openai',
  image: 'openai',
} as const;

describe('generation estimate and hard limits', () => {
  it('reports a complete real-provider estimate from server configuration', () => {
    expect(
      buildGenerationEstimate({
        kind: 'initial',
        pageCount: 6,
        providers: realProviders,
        repairEnabled: true,
        configuration: {
          storyCostUsd: 0.02,
          characterProfileCostUsd: 0.01,
          imageCostUsd: 0.04,
          durationMinSeconds: 30,
          durationMaxSeconds: 90,
        },
      }),
    ).toEqual({
      kind: 'initial',
      providerMode: 'real',
      storyCalls: 1,
      characterProfileCalls: 1,
      imageCalls: 9,
      repairAllowanceCalls: 1,
      maximumProviderCalls: 12,
      reusedProviderCalls: 0,
      estimatedCostUsd: { minimum: 0.41, maximum: 0.41, label: 'estimate' },
      expectedDurationSeconds: { minimum: 30, maximum: 90 },
    });
  });

  it('reports zero external cost for an all-mock run', () => {
    const estimate = buildGenerationEstimate({
      kind: 'initial',
      pageCount: 12,
      providers: { story: 'mock', characterProfile: 'mock', image: 'mock' },
      repairEnabled: true,
    });

    expect(estimate.maximumProviderCalls).toBe(0);
    expect(estimate.imageCalls).toBe(0);
    expect(estimate.estimatedCostUsd).toEqual({
      minimum: 0,
      maximum: 0,
      label: 'estimate',
    });
  });

  it('counts only genuinely new retry calls and excludes reused artifacts', () => {
    const estimate = buildGenerationEstimate({
      kind: 'retry',
      pageCount: 6,
      providers: realProviders,
      repairEnabled: false,
      reuse: { storyCalls: 1, characterProfileCalls: 1, imageCalls: 7 },
    });

    expect(estimate).toMatchObject({
      storyCalls: 0,
      characterProfileCalls: 0,
      imageCalls: 2,
      maximumProviderCalls: 2,
      reusedProviderCalls: 9,
    });
  });

  it('accepts exact hard-limit boundary values', () => {
    const estimate = buildGenerationEstimate({
      kind: 'initial',
      pageCount: 4,
      providers: realProviders,
      repairEnabled: false,
      configuration: {
        storyCostUsd: 0.02,
        characterProfileCostUsd: 0.01,
        imageCostUsd: 0.04,
      },
    });

    expect(() =>
      assertGenerationHardLimits(estimate, {
        maxProviderCalls: 9,
        maxImages: 7,
        maxEstimatedCostUsd: 0.31,
      }),
    ).not.toThrow();
  });

  it.each([
    ['provider_calls', { maxProviderCalls: 8, maxImages: 7 }],
    ['images', { maxProviderCalls: 9, maxImages: 6 }],
    ['estimated_cost', { maxProviderCalls: 9, maxImages: 7, maxEstimatedCostUsd: 0.3 }],
  ] as const)(
    'rejects %s before scheduling when its hard boundary is exceeded',
    (dimension, limits) => {
      const estimate = buildGenerationEstimate({
        kind: 'initial',
        pageCount: 4,
        providers: realProviders,
        repairEnabled: false,
        configuration: {
          storyCostUsd: 0.02,
          characterProfileCostUsd: 0.01,
          imageCostUsd: 0.04,
        },
      });

      expect(() => assertGenerationHardLimits(estimate, limits)).toThrowError(
        expect.objectContaining<Partial<GenerationHardBudgetError>>({ dimension }),
      );
    },
  );

  it('fails closed when a cost ceiling is configured without complete estimates', () => {
    const estimate = buildGenerationEstimate({
      kind: 'initial',
      pageCount: 4,
      providers: realProviders,
      repairEnabled: false,
    });

    expect(() =>
      assertGenerationHardLimits(estimate, {
        maxProviderCalls: 9,
        maxImages: 7,
        maxEstimatedCostUsd: 1,
      }),
    ).toThrowError(expect.objectContaining({ dimension: 'estimated_cost' }));
  });
});
