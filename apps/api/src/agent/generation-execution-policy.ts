import type { GenerationEstimateDto } from '@book/types';
import {
  buildGenerationCompatibilityFingerprint,
  type GenerationPipelineProviders,
} from './generation-compatibility-fingerprint';
import {
  assertGenerationHardLimits,
  buildGenerationEstimate,
  type GenerationEstimateReuse,
} from './generation-estimate';

export const EXECUTION_POLICY_KEYS = [
  'CHARACTER_FALLBACK_POLICY',
  'GENERATION_RUN_DEADLINE_MS',
  'MAX_PAID_PROVIDER_CALLS_PER_RUN',
  'REAL_GENERATION_MAX_PROVIDER_CALLS_PER_RUN',
  'REAL_GENERATION_MAX_IMAGES_PER_RUN',
  'REAL_GENERATION_MAX_ESTIMATED_COST_USD',
  'OPENAI_STORY_ESTIMATED_COST_USD',
  'OPENAI_CHARACTER_PROFILE_ESTIMATED_COST_USD',
  'OPENAI_IMAGE_ESTIMATED_COST_USD',
  'STORY_REPAIR_ENABLED',
] as const;

export function executionPolicy(
  providers: GenerationPipelineProviders,
  env: NodeJS.ProcessEnv = process.env,
) {
  const number = (key: string, fallback?: number) =>
    env[key] === undefined ? fallback : Number(env[key]);
  const provider = (name?: string) =>
    name === 'mock'
      ? ('mock' as const)
      : name === 'openai'
        ? ('openai' as const)
        : ('unknown' as const);
  return {
    version: 1,
    fallbackPolicy: env['CHARACTER_FALLBACK_POLICY'] ?? 'required',
    deadlineMs: number('GENERATION_RUN_DEADLINE_MS', 45 * 60_000),
    fingerprint: buildGenerationCompatibilityFingerprint(providers),
    providers: {
      story: provider(providers.story.providerName),
      characterProfile: provider(providers.character.providerName),
      image: provider(providers.image.providerName),
    },
    repairEnabled: env['STORY_REPAIR_ENABLED'] === 'true',
    maxPaidCalls: number('MAX_PAID_PROVIDER_CALLS_PER_RUN', 17)!,
    limits: {
      maxProviderCalls: number('REAL_GENERATION_MAX_PROVIDER_CALLS_PER_RUN', 17)!,
      maxImages: number('REAL_GENERATION_MAX_IMAGES_PER_RUN', 15)!,
      maxEstimatedCostUsd: number('REAL_GENERATION_MAX_ESTIMATED_COST_USD'),
    },
    configuration: {
      storyCostUsd: number('OPENAI_STORY_ESTIMATED_COST_USD'),
      characterProfileCostUsd: number('OPENAI_CHARACTER_PROFILE_ESTIMATED_COST_USD'),
      imageCostUsd: number('OPENAI_IMAGE_ESTIMATED_COST_USD'),
    },
  };
}

export type ExecutionPolicy = ReturnType<typeof executionPolicy>;
export interface ExecutionAuthorization {
  policy: ExecutionPolicy;
  estimate: GenerationEstimateDto;
}

/** Mock work never grants permission for additional paid work in another category. */
export function assertAuthorizedOperations(
  authorization: ExecutionAuthorization | null,
  operations: ReadonlyArray<Record<string, unknown>>,
): void {
  if (!authorization) return;
  const groups = {
    story: ['story', 'story_repair'],
    character: ['character_profile'],
    image: ['character_sheet', 'illustration'],
  };
  const limits = {
    story: authorization.estimate.storyCalls + authorization.estimate.repairAllowanceCalls,
    character: authorization.estimate.characterProfileCalls,
    image: authorization.estimate.imageCalls,
  };
  for (const key of Object.keys(groups) as Array<keyof typeof groups>) {
    const attempts = operations
      .filter((op) => op.provider === 'openai' && groups[key].includes(String(op.operation)))
      .reduce((sum, op) => sum + Math.max(1, Number(op.httpAttempts ?? 0)), 0);
    if (attempts > limits[key]) throw new Error('GENERATION_HARD_BUDGET_EXCEEDED');
  }
}

export function revalidateExecution(
  policy: ExecutionPolicy,
  pageCount: number,
  reuse: GenerationEstimateReuse,
  saved?: unknown,
) {
  const estimate = buildGenerationEstimate({ ...policy, kind: 'retry', pageCount, reuse });
  assertGenerationHardLimits(estimate, policy.limits);
  if (saved) {
    const authorized = saved as ExecutionAuthorization;
    // Canonical comparison also works after PostgreSQL reorders JSONB object keys.
    if (canonical(authorized.policy) !== canonical(policy))
      throw new Error('GENERATION_EXECUTION_CONFIG_DRIFT');
    assertGenerationHardLimits(estimate, {
      maxProviderCalls: authorized.estimate.maximumProviderCalls,
      maxImages: authorized.estimate.imageCalls,
      maxEstimatedCostUsd: authorized.estimate.estimatedCostUsd?.maximum,
    });
  }
  return estimate;
}

function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))
      : item,
  );
}
