import type { ScenarioDefinition } from '../domain/scenario-schema';
import type { analyzeScenario } from '../domain/scenario-analysis';
import { hashBrief, parseBrief, type ScenarioBrief } from './brief';
import type { Diagnostic, ValidationStage } from './diagnostics';
import {
  DEFAULT_DEADLINE_MS,
  DEFAULT_MAX_OUTPUT_TOKENS,
  DEFAULT_REQUEST_TIMEOUT_MS,
  MAX_CANDIDATE_CHARS,
  MAX_HTTP_ATTEMPTS,
  MAX_REQUESTS,
  PROMPT_VERSION,
  WIRE_SCHEMA_VERSION,
} from './limits';
import {
  DraftProviderError,
  type DraftFailureKind,
  type DraftRequestKind,
  type DraftResponse,
  type ScenarioDraftProvider,
} from './provider';
import {
  isPublishedInRegistry,
  validateCandidate,
  type MechanicalReport,
  type ValidationOutcome,
} from './validate';

/**
 * fictional brief → one generation request → deterministic validation →
 * (only on a content failure) at most one repair request → validation again.
 *
 * Transport or provider failures (refusal, truncation, auth, timeout, network,
 * cancellation, deadline) STOP the run with a stable reason and never trigger
 * content repair. A repaired candidate gets no shortcut: it passes the whole
 * pipeline again. No outcome here means "approved": the best result is
 * REVIEW_REQUIRED.
 */

export type StopReason =
  | 'REFUSAL'
  | 'TRUNCATED'
  | 'AUTHENTICATION'
  | 'RATE_LIMITED'
  | 'TIMEOUT'
  | 'NETWORK'
  | 'CANCELLED'
  | 'PROVIDER_ERROR'
  | 'INVALID_RESPONSE'
  | 'DEADLINE_EXCEEDED'
  | 'CALL_BUDGET_EXCEEDED';

const STOP_BY_FAILURE: Record<DraftFailureKind, StopReason> = {
  refusal: 'REFUSAL',
  truncated: 'TRUNCATED',
  authentication: 'AUTHENTICATION',
  rate_limit: 'RATE_LIMITED',
  timeout: 'TIMEOUT',
  network: 'NETWORK',
  cancelled: 'CANCELLED',
  provider_error: 'PROVIDER_ERROR',
  invalid_response: 'INVALID_RESPONSE',
};

export interface PipelineLimits {
  maxOutputTokens: number;
  requestTimeoutMs: number;
  deadlineMs: number;
}

export const DEFAULT_PIPELINE_LIMITS: PipelineLimits = {
  maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
  requestTimeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
  deadlineMs: DEFAULT_DEADLINE_MS,
};

export interface RequestRecord {
  phase: DraftRequestKind;
  httpAttempts: number;
  outcome: 'ok' | StopReason;
  /** Present only when the provider actually reported them. */
  inputTokens?: number;
  outputTokens?: number;
  durationMs: number;
  /** Result of the deterministic validation of this request's output, if any. */
  validation?: 'passed' | `failed:${ValidationStage}`;
}

export interface Provenance {
  promptVersion: string;
  schemaVersion: string;
  provider: string;
  model: string | null;
  briefHash: string | null;
  candidateHash: string | null;
  startedAt: string;
  totalDurationMs: number;
  requests: RequestRecord[];
  totalHttpAttempts: number;
  callBudget: { maxRequests: number; maxHttpAttempts: number };
  limits: PipelineLimits;
}

export type RepairDisposition = 'attempted' | 'skipped_budget_exhausted';

export type AuthoringResult =
  | {
      status: 'BRIEF_REJECTED';
      code: 'BRIEF_INVALID' | 'IDENTITY_ALREADY_PUBLISHED';
      issues: string[];
    }
  | {
      status: 'REVIEW_REQUIRED';
      /** Always false: mechanical validity is never approval. */
      approved: false;
      repaired: boolean;
      brief: ScenarioBrief;
      scenario: ScenarioDefinition;
      candidateHash: string;
      validation: MechanicalReport;
      provenance: Provenance;
    }
  | {
      status: 'REJECTED';
      stage: ValidationStage;
      diagnostics: Diagnostic[];
      droppedDiagnostics: number;
      rawSha256: string | null;
      repair: RepairDisposition;
      brief: ScenarioBrief;
      provenance: Provenance;
    }
  | {
      status: 'STOPPED';
      reason: StopReason;
      phase: DraftRequestKind;
      /** Diagnostics of the failed first candidate when the stop happened during repair. */
      priorDiagnostics: Diagnostic[];
      brief: ScenarioBrief;
      provenance: Provenance;
    };

export interface RunAuthoringOptions {
  rawBrief: unknown;
  provider: ScenarioDraftProvider;
  limits?: PipelineLimits;
  /** External cancellation (e.g. SIGINT). */
  signal?: AbortSignal | undefined;
  now?: () => number;
  isPublished?: (id: string, version: number) => boolean;
  analyze?: typeof analyzeScenario;
}

class DeadlineExceeded extends Error {
  constructor() {
    super('Overall authoring deadline exceeded');
    this.name = 'DeadlineExceeded';
  }
}

function boundedCandidateText(candidate: unknown): string {
  let text: string | undefined;
  try {
    text = typeof candidate === 'string' ? candidate : JSON.stringify(candidate);
  } catch {
    text = undefined;
  }
  return (text ?? '').slice(0, MAX_CANDIDATE_CHARS);
}

export async function runAuthoring(options: RunAuthoringOptions): Promise<AuthoringResult> {
  const now = options.now ?? Date.now;
  const limits = options.limits ?? DEFAULT_PIPELINE_LIMITS;
  const isPublished = options.isPublished ?? isPublishedInRegistry;
  const { provider } = options;

  // 0. Local brief validation and identity check, before any provider call.
  const parsedBrief = parseBrief(options.rawBrief);
  if (!parsedBrief.ok) {
    return { status: 'BRIEF_REJECTED', code: 'BRIEF_INVALID', issues: parsedBrief.issues };
  }
  const brief = parsedBrief.brief;
  if (isPublished(brief.scenarioId, brief.version)) {
    return {
      status: 'BRIEF_REJECTED',
      code: 'IDENTITY_ALREADY_PUBLISHED',
      issues: [`${brief.scenarioId}@${brief.version} is already in the scenario registry`],
    };
  }

  const startedAtMs = now();
  const provenance: Provenance = {
    promptVersion: PROMPT_VERSION,
    schemaVersion: WIRE_SCHEMA_VERSION,
    provider: provider.name,
    model: provider.model,
    briefHash: hashBrief(brief),
    candidateHash: null,
    startedAt: new Date(startedAtMs).toISOString(),
    totalDurationMs: 0,
    requests: [],
    totalHttpAttempts: 0,
    callBudget: { maxRequests: MAX_REQUESTS, maxHttpAttempts: MAX_HTTP_ATTEMPTS },
    limits,
  };

  // Overall deadline + external cancellation share one signal.
  const controller = new AbortController();
  const deadlineTimer = setTimeout(
    () => controller.abort(new DeadlineExceeded()),
    limits.deadlineMs,
  );
  const onExternalAbort = () => controller.abort(options.signal?.reason);
  if (options.signal?.aborted) onExternalAbort();
  else options.signal?.addEventListener('abort', onExternalAbort, { once: true });
  const deadlineAtMs = startedAtMs + limits.deadlineMs;

  const finish = <T extends AuthoringResult>(result: T): T => {
    provenance.totalDurationMs = now() - startedAtMs;
    return result;
  };
  const abortReason = (): StopReason =>
    controller.signal.reason instanceof DeadlineExceeded ? 'DEADLINE_EXCEEDED' : 'CANCELLED';

  try {
    let previous: { candidateText: string; diagnostics: Diagnostic[] } | undefined;
    let priorDiagnostics: Diagnostic[] = [];

    for (const phase of ['generate', 'repair'] as const) {
      if (controller.signal.aborted) {
        return finish({
          status: 'STOPPED',
          reason: abortReason(),
          phase,
          priorDiagnostics,
          brief,
          provenance,
        });
      }

      const callStart = now();
      const record: RequestRecord = {
        phase,
        httpAttempts: 0,
        outcome: 'ok',
        durationMs: 0,
      };
      provenance.requests.push(record);

      let response: DraftResponse;
      try {
        response = await provider.draft({
          kind: phase,
          brief,
          previous,
          maxOutputTokens: limits.maxOutputTokens,
          timeoutMs: Math.max(1, Math.min(limits.requestTimeoutMs, deadlineAtMs - callStart)),
          signal: controller.signal,
        });
      } catch (error) {
        const attempts = error instanceof DraftProviderError ? error.httpAttempts : 1;
        record.httpAttempts = attempts;
        provenance.totalHttpAttempts += attempts;
        if (error instanceof DraftProviderError) {
          if (error.usage.inputTokens !== undefined) record.inputTokens = error.usage.inputTokens;
          if (error.usage.outputTokens !== undefined)
            record.outputTokens = error.usage.outputTokens;
        }
        record.outcome = controller.signal.aborted
          ? abortReason()
          : error instanceof DraftProviderError
            ? STOP_BY_FAILURE[error.kind]
            : 'PROVIDER_ERROR';
        record.durationMs = now() - callStart;
        return finish({
          status: 'STOPPED',
          reason: record.outcome,
          phase,
          priorDiagnostics,
          brief,
          provenance,
        });
      }

      record.durationMs = now() - callStart;
      record.httpAttempts = response.httpAttempts;
      provenance.totalHttpAttempts += response.httpAttempts;
      if (response.usage.inputTokens !== undefined) record.inputTokens = response.usage.inputTokens;
      if (response.usage.outputTokens !== undefined)
        record.outputTokens = response.usage.outputTokens;

      if (provenance.totalHttpAttempts > MAX_HTTP_ATTEMPTS) {
        record.outcome = 'CALL_BUDGET_EXCEEDED';
        return finish({
          status: 'STOPPED',
          reason: 'CALL_BUDGET_EXCEEDED',
          phase,
          priorDiagnostics,
          brief,
          provenance,
        });
      }
      if (controller.signal.aborted) {
        record.outcome = abortReason();
        return finish({
          status: 'STOPPED',
          reason: record.outcome,
          phase,
          priorDiagnostics,
          brief,
          provenance,
        });
      }

      const outcome: ValidationOutcome = validateCandidate(response.candidate, {
        brief,
        isPublished,
        ...(options.analyze && { analyze: options.analyze }),
      });
      if (outcome.ok) {
        record.validation = 'passed';
        provenance.candidateHash = outcome.candidateHash;
        return finish({
          status: 'REVIEW_REQUIRED',
          approved: false,
          repaired: phase === 'repair',
          brief,
          scenario: outcome.scenario,
          candidateHash: outcome.candidateHash,
          validation: outcome.report,
          provenance,
        });
      }
      record.validation = `failed:${outcome.stage}`;

      if (phase === 'repair') {
        return finish({
          status: 'REJECTED',
          stage: outcome.stage,
          diagnostics: outcome.diagnostics,
          droppedDiagnostics: outcome.droppedDiagnostics,
          rawSha256: outcome.rawSha256,
          repair: 'attempted',
          brief,
          provenance,
        });
      }

      // First candidate failed deterministic validation: at most one repair.
      priorDiagnostics = outcome.diagnostics;
      previous = {
        candidateText: boundedCandidateText(response.candidate),
        diagnostics: outcome.diagnostics,
      };
      if (
        provenance.requests.length >= MAX_REQUESTS ||
        provenance.totalHttpAttempts >= MAX_HTTP_ATTEMPTS
      ) {
        return finish({
          status: 'REJECTED',
          stage: outcome.stage,
          diagnostics: outcome.diagnostics,
          droppedDiagnostics: outcome.droppedDiagnostics,
          rawSha256: outcome.rawSha256,
          repair: 'skipped_budget_exhausted',
          brief,
          provenance,
        });
      }
    }
    // Both loop iterations return; the budget check after a failed first candidate
    // guarantees a repair is only started while the call budget allows it.
    throw new Error('unreachable: authoring loop always returns');
  } finally {
    clearTimeout(deadlineTimer);
    options.signal?.removeEventListener('abort', onExternalAbort);
  }
}
