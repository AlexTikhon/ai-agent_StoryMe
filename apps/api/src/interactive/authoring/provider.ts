import type { ScenarioBrief } from './brief';
import type { Diagnostic } from './diagnostics';
import { LAST_TRAM_SCENARIO } from './the-last-tram';
import { scenarioToWire } from './wire';

/**
 * Boundary between the authoring pipeline and whatever proposes a candidate.
 * Deliberately independent of the children's-book StoryGenerationProvider: a
 * provider returns an UNTRUSTED `unknown` and never sees tools, files or the
 * network beyond its own transport. The pipeline validates everything.
 */

export type DraftRequestKind = 'generate' | 'repair';

export interface DraftRequest {
  kind: DraftRequestKind;
  brief: ScenarioBrief;
  /** Repair only: the bounded previous output and the deterministic diagnostics. */
  previous?: { candidateText: string; diagnostics: Diagnostic[] } | undefined;
  maxOutputTokens: number;
  /** Per-request timeout, already clamped to the remaining overall deadline. */
  timeoutMs: number;
  signal?: AbortSignal | undefined;
}

export interface DraftUsage {
  inputTokens?: number;
  outputTokens?: number;
}

export interface DraftResponse {
  /** Untrusted. OpenAI returns the message content string; the mock returns JSON text. */
  candidate: unknown;
  /** Only what the provider actually reported; never estimated. */
  usage: DraftUsage;
  /** HTTP attempts actually dispatched for this request (0 for the offline mock). */
  httpAttempts: number;
}

export type DraftFailureKind =
  | 'refusal'
  | 'truncated'
  | 'authentication'
  | 'rate_limit'
  | 'timeout'
  | 'network'
  | 'cancelled'
  | 'provider_error'
  | 'invalid_response';

/** Carries only a stable kind: provider error bodies and messages are never propagated. */
export class DraftProviderError extends Error {
  constructor(
    readonly kind: DraftFailureKind,
    readonly httpAttempts: number = 0,
    readonly usage: DraftUsage = {},
  ) {
    super(`Draft provider failure: ${kind}`);
    this.name = 'DraftProviderError';
  }
}

export interface ScenarioDraftProvider {
  readonly name: 'mock' | 'openai' | 'scripted';
  /** Explicitly configured model, or null for the offline mock. */
  readonly model: string | null;
  draft(request: DraftRequest): Promise<DraftResponse>;
}

/** Offline and deterministic: always proposes the bundled original episode. */
export class MockScenarioDraftProvider implements ScenarioDraftProvider {
  readonly name = 'mock' as const;
  readonly model = null;

  draft(_request: DraftRequest): Promise<DraftResponse> {
    return Promise.resolve({
      candidate: JSON.stringify(scenarioToWire(LAST_TRAM_SCENARIO)),
      usage: {},
      httpAttempts: 0,
    });
  }
}
