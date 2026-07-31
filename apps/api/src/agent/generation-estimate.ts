import type {
  GenerationEstimateDto,
  GenerationEstimateKind,
  GenerationProviderName,
} from '@book/types';

export const GENERATION_HARD_BUDGET_EXCEEDED = 'GENERATION_HARD_BUDGET_EXCEEDED';

export interface GenerationEstimateProviders {
  story: GenerationProviderName;
  characterProfile: GenerationProviderName;
  image: GenerationProviderName;
}

export interface GenerationEstimateReuse {
  storyCalls?: number;
  characterProfileCalls?: number;
  imageCalls?: number;
}

export interface GenerationEstimateConfiguration {
  storyCostUsd?: number;
  characterProfileCostUsd?: number;
  imageCostUsd?: number;
  durationMinSeconds?: number;
  durationMaxSeconds?: number;
}

export interface GenerationHardLimits {
  maxProviderCalls: number;
  maxImages: number;
  maxEstimatedCostUsd?: number;
}

export function buildGenerationEstimate(input: {
  kind: GenerationEstimateKind;
  pageCount: number;
  providers: GenerationEstimateProviders;
  repairEnabled: boolean;
  reuse?: GenerationEstimateReuse;
  configuration?: GenerationEstimateConfiguration;
}): GenerationEstimateDto {
  const planned = {
    storyCalls: input.providers.story === 'openai' ? 1 : 0,
    characterProfileCalls: input.providers.characterProfile === 'openai' ? 1 : 0,
    imageCalls: input.providers.image === 'openai' ? input.pageCount + 3 : 0,
    repairAllowanceCalls: input.providers.story === 'openai' && input.repairEnabled ? 1 : 0,
  };
  const reused = {
    storyCalls: Math.min(input.reuse?.storyCalls ?? 0, planned.storyCalls),
    characterProfileCalls: Math.min(
      input.reuse?.characterProfileCalls ?? 0,
      planned.characterProfileCalls,
    ),
    imageCalls: Math.min(input.reuse?.imageCalls ?? 0, planned.imageCalls),
  };
  const storyCalls = planned.storyCalls - reused.storyCalls;
  const characterProfileCalls = planned.characterProfileCalls - reused.characterProfileCalls;
  const imageCalls = planned.imageCalls - reused.imageCalls;
  // A repair is conditional future work and is never treated as already reused.
  const repairAllowanceCalls = planned.repairAllowanceCalls;
  const maximumProviderCalls =
    storyCalls + characterProfileCalls + imageCalls + repairAllowanceCalls;
  const reusedProviderCalls = reused.storyCalls + reused.characterProfileCalls + reused.imageCalls;
  const providerMode = Object.values(input.providers).includes('openai') ? 'real' : 'mock';

  const costs = input.configuration;
  const hasCompleteCostConfiguration =
    costs?.storyCostUsd !== undefined &&
    costs.characterProfileCostUsd !== undefined &&
    costs.imageCostUsd !== undefined;
  const unroundedExpectedCost =
    hasCompleteCostConfiguration && providerMode === 'real'
      ? storyCalls * costs.storyCostUsd! +
        characterProfileCalls * costs.characterProfileCostUsd! +
        repairAllowanceCalls * costs.storyCostUsd! +
        imageCalls * costs.imageCostUsd!
      : 0;
  const expectedCost = Math.round(unroundedExpectedCost * 1_000_000) / 1_000_000;

  return {
    kind: input.kind,
    providerMode,
    storyCalls,
    characterProfileCalls,
    imageCalls,
    repairAllowanceCalls,
    maximumProviderCalls,
    reusedProviderCalls,
    ...((providerMode === 'mock' || maximumProviderCalls === 0 || hasCompleteCostConfiguration) && {
      estimatedCostUsd: {
        minimum: expectedCost,
        maximum: expectedCost,
        label: 'estimate' as const,
      },
    }),
    ...(costs?.durationMinSeconds !== undefined &&
      costs.durationMaxSeconds !== undefined && {
        expectedDurationSeconds: {
          minimum: costs.durationMinSeconds,
          maximum: costs.durationMaxSeconds,
        },
      }),
  };
}

export class GenerationHardBudgetError extends Error {
  constructor(
    readonly dimension: 'provider_calls' | 'images' | 'estimated_cost',
    readonly required: number,
    readonly configuredLimit: number,
  ) {
    super(`Generation estimate exceeds the configured ${dimension} hard limit`);
    this.name = 'GenerationHardBudgetError';
  }
}

export function assertGenerationHardLimits(
  estimate: GenerationEstimateDto,
  limits: GenerationHardLimits,
): void {
  if (estimate.maximumProviderCalls > limits.maxProviderCalls) {
    throw new GenerationHardBudgetError(
      'provider_calls',
      estimate.maximumProviderCalls,
      limits.maxProviderCalls,
    );
  }
  if (estimate.imageCalls > limits.maxImages) {
    throw new GenerationHardBudgetError('images', estimate.imageCalls, limits.maxImages);
  }
  if (
    limits.maxEstimatedCostUsd !== undefined &&
    estimate.providerMode === 'real' &&
    estimate.estimatedCostUsd === undefined
  ) {
    throw new GenerationHardBudgetError(
      'estimated_cost',
      Number.POSITIVE_INFINITY,
      limits.maxEstimatedCostUsd,
    );
  }
  if (
    limits.maxEstimatedCostUsd !== undefined &&
    estimate.estimatedCostUsd !== undefined &&
    estimate.estimatedCostUsd.maximum > limits.maxEstimatedCostUsd
  ) {
    throw new GenerationHardBudgetError(
      'estimated_cost',
      estimate.estimatedCostUsd.maximum,
      limits.maxEstimatedCostUsd,
    );
  }
}
