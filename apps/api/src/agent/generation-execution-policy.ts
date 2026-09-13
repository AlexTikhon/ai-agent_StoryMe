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
import { GenerationControlError } from '../common/provider-execution';

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
  'OPENAI_MAX_RETRIES',
  'OPENAI_IMAGE_TIMEOUT_MAX_RETRIES',
  'OPENAI_IMAGE_MAX_RETRIES',
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
    transport: {
      textRetries: number('OPENAI_MAX_RETRIES', 2)!,
      imageTimeoutRetries: number('OPENAI_IMAGE_TIMEOUT_MAX_RETRIES', 1)!,
      imageRateLimitRetries: number('OPENAI_IMAGE_MAX_RETRIES', 5)!,
    },
  };
}

export type ExecutionPolicy = ReturnType<typeof executionPolicy>;
export interface ExecutionAuthorization {
  version?: 1 | 2;
  policy: ExecutionPolicy;
  estimate: GenerationEstimateDto;
  envelope?: {
    logicalOperations: { story: number; character: number; image: number };
    attemptsPerOperation: { story: number; character: number; image: number };
    maxDispatches: number;
    maxEstimatedExposureUsd?: number;
    repairAllowance: number;
  };
}

export function buildExecutionAuthorization(
  policy: ExecutionPolicy,
  estimate: GenerationEstimateDto,
): ExecutionAuthorization {
  const textAttempts = Math.max(1, 1 + policy.transport.textRetries);
  const imageAttempts = Math.max(
    1,
    (1 + policy.transport.imageRateLimitRetries) *
      (1 + policy.transport.textRetries + policy.transport.imageTimeoutRetries),
  );
  return {
    version: 2,
    policy,
    estimate,
    envelope: {
      logicalOperations: {
        story: estimate.storyCalls + estimate.repairAllowanceCalls,
        character: estimate.characterProfileCalls,
        image: estimate.imageCalls,
      },
      attemptsPerOperation: {
        story: textAttempts,
        character: textAttempts,
        image: imageAttempts,
      },
      maxDispatches: policy.limits.maxProviderCalls,
      ...(policy.limits.maxEstimatedCostUsd !== undefined && {
        maxEstimatedExposureUsd: policy.limits.maxEstimatedCostUsd,
      }),
      repairAllowance: estimate.repairAllowanceCalls,
    },
  };
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
  const logical = authorization.envelope?.logicalOperations ?? {
    story: authorization.estimate.storyCalls + authorization.estimate.repairAllowanceCalls,
    character: authorization.estimate.characterProfileCalls,
    image: authorization.estimate.imageCalls,
  };
  const perOperation = authorization.envelope?.attemptsPerOperation ?? {
    story: 1,
    character: 1,
    image: 1,
  };
  for (const key of Object.keys(groups) as Array<keyof typeof groups>) {
    const categoryOperations = operations.filter(
      (op) => op.provider === 'openai' && groups[key].includes(String(op.operation)),
    );
    const logicalIdentities = new Set(
      categoryOperations.map((op, index) =>
        typeof op.operationId === 'string'
          ? op.operationId
          : `legacy:${String(op.operation)}:${String(op.assetLabel ?? '')}:${index}`,
      ),
    );
    if (logicalIdentities.size > logical[key]) {
      throw new GenerationControlError('budget_rejection', 'GENERATION_HARD_BUDGET_EXCEEDED');
    }
    const attempts = categoryOperations.reduce((sum, op) => sum + countAuthorizedDispatches(op), 0);
    if (attempts > logical[key] * perOperation[key])
      throw new GenerationControlError('budget_rejection', 'GENERATION_HARD_BUDGET_EXCEEDED');
  }
  const totalDispatches = operations
    .filter((op) => op.provider === 'openai')
    .reduce((sum, op) => sum + countAuthorizedDispatches(op), 0);
  if (
    totalDispatches >
    (authorization.envelope?.maxDispatches ?? authorization.estimate.maximumProviderCalls)
  )
    throw new GenerationControlError('budget_rejection', 'GENERATION_HARD_BUDGET_EXCEEDED');
}

/** Explicit reserved_unsent is the only durable proof that no dispatch happened. */
export function countAuthorizedDispatches(operation: Record<string, unknown>): number {
  const recorded = Number(operation.httpAttempts);
  if (Number.isFinite(recorded) && recorded >= 0) return Math.floor(recorded);
  return operation.state === 'reserved_unsent' ? 0 : 1;
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
      throw new GenerationControlError('configuration_drift', 'GENERATION_EXECUTION_CONFIG_DRIFT');
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
