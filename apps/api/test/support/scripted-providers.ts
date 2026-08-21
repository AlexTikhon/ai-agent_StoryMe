import type { ProviderCallMetrics, ProviderFailureKind } from '@book/types';
import type {
  CharacterProfileInput,
  CharacterProfileProvider,
} from '../../src/agent/character-profile-provider';
import { MockCharacterProfileProvider } from '../../src/agent/character-profile-provider';
import type {
  StoryGenerationInput,
  StoryGenerationProvider,
  StoryGenerationResult,
  StoryRepairInput,
} from '../../src/agent/story-generation-provider';
import { MockStoryGenerationProvider } from '../../src/agent/story-generation-provider';
import type {
  CharacterSheetInput,
  ImageGenerationInput,
  ImageGenerationOutput,
  ImageGenerationProvider,
} from '../../src/images/image-generation-provider';
import { MockImageGenerationProvider } from '../../src/images/image-generation-provider';
import {
  cancellableSleep,
  ProviderCancellationError,
  type ProviderExecutionOptions,
  reportProviderMetrics,
  throwIfAborted,
} from '../../src/common/provider-execution';

export type ScriptedProviderResult =
  | 'success'
  | 'timeout'
  | 'rate_limit'
  | 'network_error'
  | 'provider_error'
  | 'invalid_response'
  | 'cancelled'
  | 'delay';

export interface ScriptedProviderStep {
  result: ScriptedProviderResult;
  /** Delay before this result; `delay` steps continue to the next script item. */
  delayMs?: number;
  /** Deliberately unsafe fixture text used to prove persistence redaction. */
  privateMessage?: string;
}

export interface ScriptedProviderStats {
  logicalCalls: number;
  httpAttempts: number;
  retries: number;
  rateLimitHits: number;
  timeoutCount: number;
  cancelledCalls: number;
}

type RetryableScriptedFailure = 'timeout' | 'rate_limit' | 'network_error';

function failureKind(
  result: Exclude<ScriptedProviderResult, 'success' | 'delay'>,
): ProviderFailureKind {
  return result === 'network_error' ? 'network' : result;
}

function isRetryable(result: ScriptedProviderResult): result is RetryableScriptedFailure {
  return result === 'timeout' || result === 'rate_limit' || result === 'network_error';
}

class ScriptedProviderError extends Error {
  readonly failureKind: ProviderFailureKind;

  constructor(
    result: Exclude<ScriptedProviderResult, 'success' | 'delay' | 'cancelled'>,
    message?: string,
  ) {
    super(message ?? `Injected ${result} provider failure`);
    this.name = 'ScriptedProviderError';
    this.failureKind = failureKind(result);
  }
}

class ScriptedCallSequence {
  readonly stats: ScriptedProviderStats = {
    logicalCalls: 0,
    httpAttempts: 0,
    retries: 0,
    rateLimitHits: 0,
    timeoutCount: 0,
    cancelledCalls: 0,
  };

  constructor(private readonly steps: ScriptedProviderStep[]) {}

  async execute<T>(
    options: ProviderExecutionOptions | undefined,
    success: () => Promise<T>,
  ): Promise<T> {
    this.stats.logicalCalls++;
    const metrics: ProviderCallMetrics = {
      httpAttempts: 0,
      retries: 0,
      rateLimitHits: 0,
      rateLimitWaitMs: 0,
      retryAfterHonoredCount: 0,
      timeoutCount: 0,
    };

    for (;;) {
      throwIfAborted(options?.signal);
      const step = this.steps.shift();
      if (!step) throw new Error('Scripted provider sequence exhausted');
      if (step.delayMs && step.delayMs > 0) {
        await cancellableSleep(step.delayMs, options?.signal);
      }
      if (step.result === 'delay') continue;

      this.stats.httpAttempts++;
      metrics.httpAttempts = (metrics.httpAttempts ?? 0) + 1;

      if (step.result === 'success') {
        reportProviderMetrics(options ?? {}, metrics);
        return success();
      }

      if (step.result === 'cancelled') {
        this.stats.cancelledCalls++;
        reportProviderMetrics(options ?? {}, metrics);
        throw new ProviderCancellationError(step.privateMessage);
      }

      if (step.result === 'rate_limit') {
        this.stats.rateLimitHits++;
        metrics.rateLimitHits = (metrics.rateLimitHits ?? 0) + 1;
      }
      if (step.result === 'timeout') {
        this.stats.timeoutCount++;
        metrics.timeoutCount = (metrics.timeoutCount ?? 0) + 1;
      }

      if (isRetryable(step.result) && this.steps.length > 0) {
        this.stats.retries++;
        metrics.retries = (metrics.retries ?? 0) + 1;
        if (step.result === 'rate_limit') {
          const waitMs = step.delayMs ?? 0;
          metrics.rateLimitWaitMs = (metrics.rateLimitWaitMs ?? 0) + waitMs;
          metrics.retryAfterHonoredCount = (metrics.retryAfterHonoredCount ?? 0) + 1;
        }
        reportProviderMetrics(options ?? {}, metrics);
        continue;
      }

      reportProviderMetrics(options ?? {}, metrics);
      throw new ScriptedProviderError(step.result, step.privateMessage);
    }
  }
}

export function failThenSucceed(
  result: RetryableScriptedFailure,
  options: { delayMs?: number; privateMessage?: string } = {},
): ScriptedProviderStep[] {
  return [{ result, ...options }, { result: 'success' }];
}

export class ScriptedStoryProvider implements StoryGenerationProvider {
  readonly providerName = 'mock' as const;
  readonly modelName = 'scripted-local-story';
  readonly promptVersion = 'scripted-story-v1';
  readonly calls: Array<{ operation: 'story' | 'repair'; input: unknown }> = [];
  private readonly sequence: ScriptedCallSequence;

  constructor(
    steps: ScriptedProviderStep[],
    private readonly delegate: StoryGenerationProvider = new MockStoryGenerationProvider(),
  ) {
    this.sequence = new ScriptedCallSequence([...steps]);
  }

  get stats(): Readonly<ScriptedProviderStats> {
    return this.sequence.stats;
  }

  async generateStory(
    input: StoryGenerationInput,
    options?: ProviderExecutionOptions,
  ): Promise<StoryGenerationResult> {
    this.calls.push({ operation: 'story', input });
    return this.sequence.execute(options, () =>
      this.delegate.generateStory(input, { signal: options?.signal }),
    );
  }

  async repairStory(
    input: StoryRepairInput,
    options?: ProviderExecutionOptions,
  ): Promise<StoryGenerationResult> {
    this.calls.push({ operation: 'repair', input });
    return this.sequence.execute(options, async () => {
      if (!this.delegate.repairStory) throw new Error('Delegate does not support story repair');
      return this.delegate.repairStory(input, { signal: options?.signal });
    });
  }
}

export class ScriptedCharacterProvider implements CharacterProfileProvider {
  readonly providerName = 'mock' as const;
  readonly modelName = 'scripted-local-character';
  readonly promptVersion = 'scripted-character-v1';
  readonly calls: CharacterProfileInput[] = [];
  private readonly sequence: ScriptedCallSequence;

  constructor(
    steps: ScriptedProviderStep[],
    private readonly delegate: CharacterProfileProvider = new MockCharacterProfileProvider(),
  ) {
    this.sequence = new ScriptedCallSequence([...steps]);
  }

  get stats(): Readonly<ScriptedProviderStats> {
    return this.sequence.stats;
  }

  async buildProfile(input: CharacterProfileInput, options?: ProviderExecutionOptions) {
    this.calls.push(input);
    return this.sequence.execute(options, () =>
      this.delegate.buildProfile(input, { signal: options?.signal }),
    );
  }
}

export class ScriptedImageProvider implements ImageGenerationProvider {
  readonly providerName = 'mock' as const;
  readonly modelName = 'scripted-local-image';
  readonly promptVersion = 'scripted-image-v1';
  readonly calls: Array<{ operation: 'image' | 'character_sheet'; input: unknown }> = [];
  private readonly sequence: ScriptedCallSequence;

  constructor(
    steps: ScriptedProviderStep[],
    private readonly delegate: ImageGenerationProvider = new MockImageGenerationProvider(),
  ) {
    this.sequence = new ScriptedCallSequence([...steps]);
  }

  get stats(): Readonly<ScriptedProviderStats> {
    return this.sequence.stats;
  }

  async generateImage(
    input: ImageGenerationInput,
    options?: ProviderExecutionOptions,
  ): Promise<ImageGenerationOutput> {
    this.calls.push({ operation: 'image', input });
    return this.sequence.execute(options, () =>
      this.delegate.generateImage(input, { signal: options?.signal }),
    );
  }

  async generateCharacterSheet(
    input: CharacterSheetInput,
    options?: ProviderExecutionOptions,
  ): Promise<ImageGenerationOutput> {
    this.calls.push({ operation: 'character_sheet', input });
    return this.sequence.execute(options, () =>
      this.delegate.generateCharacterSheet(input, { signal: options?.signal }),
    );
  }
}
