import { createHash } from 'node:crypto';
import type {
  GenerationProviderCallMetadata,
  GenerationProviderName,
  GenerationProviderOperation,
  GenerationProviderUsage,
} from '@book/types';

export const DEFAULT_MAX_PAID_PROVIDER_CALLS_PER_RUN = 17;

export class PaidProviderCallBudgetError extends Error {
  constructor(
    readonly requiredCalls: number,
    readonly configuredLimit: number,
  ) {
    super(
      `Complete book generation requires up to ${requiredCalls} paid provider calls, but MAX_PAID_PROVIDER_CALLS_PER_RUN is ${configuredLimit}`,
    );
    this.name = 'PaidProviderCallBudgetError';
  }
}

export interface PaidProviderSelection {
  readonly storyProvider: string | undefined;
  readonly characterProfileProvider: string | undefined;
  readonly imageProvider: string | undefined;
}

export function requiredPaidProviderCallsForBook(
  pageCount: number,
  providers: PaidProviderSelection,
): number {
  return (
    (providers.characterProfileProvider === 'openai' ? 1 : 0) +
    (providers.storyProvider === 'openai' ? 1 : 0) +
    // One character sheet plus cover + pages + back cover.
    (providers.imageProvider === 'openai' ? pageCount + 3 : 0)
  );
}

export function resolveMaxPaidProviderCallsPerRun(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = Number(env['MAX_PAID_PROVIDER_CALLS_PER_RUN']);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_PAID_PROVIDER_CALLS_PER_RUN;
}

export function assertPaidProviderCallBudget(requiredCalls: number, configuredLimit: number): void {
  if (requiredCalls > configuredLimit) {
    throw new PaidProviderCallBudgetError(requiredCalls, configuredLimit);
  }
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, stableValue(nested)]),
    );
  }
  return value;
}

/** SHA-256 fingerprint of a versioned normalized provider input. */
export function hashProviderPrompt(promptVersion: string, input: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify({ promptVersion, input: stableValue(input) }))
    .digest('hex');
}

function readEstimatedCostUsd(
  operation: GenerationProviderOperation,
  provider: GenerationProviderName,
  env: NodeJS.ProcessEnv,
): number | undefined {
  if (provider === 'mock') return 0;
  if (provider !== 'openai') return undefined;
  const envKey: Record<GenerationProviderOperation, string> = {
    character_profile: 'OPENAI_CHARACTER_PROFILE_ESTIMATED_COST_USD',
    character_sheet: 'OPENAI_IMAGE_ESTIMATED_COST_USD',
    story: 'OPENAI_STORY_ESTIMATED_COST_USD',
    illustration: 'OPENAI_IMAGE_ESTIMATED_COST_USD',
  };
  const raw = env[envKey[operation]];
  if (raw === undefined || raw.trim() === '') return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

interface RecordProviderCallInput<T> {
  operation: GenerationProviderOperation;
  assetLabel?: string;
  provider: GenerationProviderName;
  model?: string;
  promptVersion: string;
  promptInput: unknown;
  execute: () => Promise<T>;
}

/**
 * Per-run collector for logical provider calls. HTTP retries remain provider
 * internals; `attempt` is the logical invocation number for that operation
 * and asset within this immutable GenerationRun.
 */
export class GenerationProviderTelemetry {
  private readonly calls: GenerationProviderCallMetadata[] = [];
  private nextCallIndex = 1;
  private paidCallsStarted = 0;

  constructor(
    private readonly maxPaidCalls: number,
    private readonly plannedPaidCalls: number,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {
    assertPaidProviderCallBudget(plannedPaidCalls, maxPaidCalls);
  }

  async record<T>(input: RecordProviderCallInput<T>): Promise<T> {
    const callIndex = this.nextCallIndex++;
    if (input.provider === 'openai' && this.paidCallsStarted >= this.maxPaidCalls) {
      throw new PaidProviderCallBudgetError(this.paidCallsStarted + 1, this.maxPaidCalls);
    }
    if (input.provider === 'openai') {
      // Reserve synchronously before awaiting so concurrent illustration
      // calls cannot all observe the same pre-call count and cross the cap.
      this.paidCallsStarted++;
    }

    const startedAt = Date.now();
    const estimatedCostUsd = readEstimatedCostUsd(input.operation, input.provider, this.env);
    const base = {
      callIndex,
      operation: input.operation,
      ...(input.assetLabel && { assetLabel: input.assetLabel }),
      provider: input.provider,
      ...(input.model && { model: input.model }),
      promptVersion: input.promptVersion,
      promptHash: hashProviderPrompt(input.promptVersion, input.promptInput),
      attempt:
        this.calls.filter(
          (call) => call.operation === input.operation && call.assetLabel === input.assetLabel,
        ).length + 1,
      ...(estimatedCostUsd !== undefined && { estimatedCostUsd }),
    };

    try {
      const result = await input.execute();
      this.calls.push({
        ...base,
        durationMs: Date.now() - startedAt,
        status: 'success',
      });
      return result;
    } catch (error) {
      this.calls.push({
        ...base,
        durationMs: Date.now() - startedAt,
        status: 'error',
      });
      throw error;
    }
  }

  snapshot(): GenerationProviderUsage {
    const calls = [...this.calls].sort((left, right) => left.callIndex - right.callIndex);
    const paidCalls = calls.filter((call) => call.provider === 'openai');
    const allPaidCallsEstimated = paidCalls.every((call) => call.estimatedCostUsd !== undefined);
    return {
      maxPaidCalls: this.maxPaidCalls,
      plannedPaidCalls: this.plannedPaidCalls,
      actualPaidCalls: paidCalls.length,
      ...(allPaidCallsEstimated && {
        estimatedCostUsd: paidCalls.reduce(
          (total, call) => total + (call.estimatedCostUsd ?? 0),
          0,
        ),
      }),
      calls,
    };
  }
}
