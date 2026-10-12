import { z } from 'zod';
import { VALIDATION_STAGES, type ValidationStage } from './diagnostics';
import type { RepairDisposition, StopReason } from './pipeline';
import type { DraftRequestKind, ScenarioDraftProvider } from './provider';

/**
 * Parsing and consistency checking of saved authoring run reports
 * (`validation-report.json` for REVIEW_REQUIRED, `run-report.json` for REJECTED
 * and STOPPED). Pure: text in, an allowlisted observation or a stable failure
 * code out. No filesystem, provider, database or network.
 *
 * It reads only run telemetry. Candidate titles, diagnostics, prompts, provider
 * payloads and raw-output hashes are never copied into an observation, and a
 * failure carries only a fixed code plus a fixed detail vocabulary or a schema
 * path made of known keys, never a value taken from the input.
 */

export const REPORT_FILE_NAMES = ['validation-report.json', 'run-report.json'] as const;
export type ReportFileName = (typeof REPORT_FILE_NAMES)[number];

// Exhaustive records: adding a member to the production union is a type error here.
const STOP_REASON_SET: Record<StopReason, true> = {
  REFUSAL: true,
  TRUNCATED: true,
  AUTHENTICATION: true,
  RATE_LIMITED: true,
  TIMEOUT: true,
  NETWORK: true,
  CANCELLED: true,
  PROVIDER_ERROR: true,
  INVALID_RESPONSE: true,
  DEADLINE_EXCEEDED: true,
  CALL_BUDGET_EXCEEDED: true,
};
export const STOP_REASONS = Object.keys(STOP_REASON_SET) as StopReason[];

const PROVIDER_SET: Record<ScenarioDraftProvider['name'], true> = {
  mock: true,
  openai: true,
  scripted: true,
};
export const PROVIDER_NAMES = Object.keys(PROVIDER_SET) as Array<ScenarioDraftProvider['name']>;

const REPAIR_DISPOSITION_SET: Record<RepairDisposition, true> = {
  attempted: true,
  skipped_budget_exhausted: true,
};
const REPAIR_DISPOSITIONS = Object.keys(REPAIR_DISPOSITION_SET) as RepairDisposition[];

// ── Observation (the only shape the aggregation sees) ───────────────────────

export type RequestValidation =
  | { verdict: 'passed' }
  | { verdict: 'failed'; stage: ValidationStage };

export interface RequestObservation {
  phase: DraftRequestKind;
  outcome: 'ok' | StopReason;
  httpAttempts: number;
  durationMs: number;
  /** null = the provider did not report it (unknown, never zero). */
  inputTokens: number | null;
  outputTokens: number | null;
  /** null = the output was never validated (the request ended in a stop). */
  validation: RequestValidation | null;
}

export interface RunGroupKey {
  provider: ScenarioDraftProvider['name'];
  model: string | null;
  promptVersion: string;
  wireSchemaVersion: string;
  briefHash: string;
}

export interface RunObservation {
  status: 'REVIEW_REQUIRED' | 'REJECTED' | 'STOPPED';
  group: RunGroupKey;
  /** REVIEW_REQUIRED only: the accepted candidate came from the repair request. */
  repaired: boolean;
  rejectedStage: ValidationStage | null;
  repairDisposition: RepairDisposition | null;
  stopReason: StopReason | null;
  stopPhase: DraftRequestKind | null;
  requests: RequestObservation[];
  totalHttpAttempts: number;
  totalDurationMs: number;
}

export type ReportErrorCode =
  | 'MALFORMED_JSON'
  | 'SCHEMA_INVALID'
  | 'KIND_MISMATCH'
  | 'INCONSISTENT_TELEMETRY';

export type ParseOutcome =
  | { ok: true; observation: RunObservation }
  | { ok: false; code: ReportErrorCode; detail: string };

// ── Schema ──────────────────────────────────────────────────────────────────

const LABEL = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,99}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

// Per-value caps keep every aggregate far below Number.MAX_SAFE_INTEGER.
const MAX_TOKENS = 1e12;
const MAX_DURATION_MS = 1e10;
const MAX_ATTEMPTS = 1000;

const count = (max: number) => z.number().int().min(0).max(max);
const label = z.string().regex(LABEL);
const sha256 = z.string().regex(SHA256);
const enumOf = <T extends string>(values: readonly T[]) =>
  z.enum(values as unknown as [T, ...T[]]);

const STAGE_RESULTS = ['passed', ...VALIDATION_STAGES.map((s) => `failed:${s}`)];

const requestSchema = z.object({
  phase: z.enum(['generate', 'repair']),
  httpAttempts: count(MAX_ATTEMPTS),
  outcome: enumOf<string>(['ok', ...STOP_REASONS]),
  inputTokens: count(MAX_TOKENS).optional(),
  outputTokens: count(MAX_TOKENS).optional(),
  durationMs: z.number().min(0).max(MAX_DURATION_MS),
  validation: enumOf<string>(STAGE_RESULTS).optional(),
});

const provenanceSchema = z.object({
  promptVersion: label,
  schemaVersion: label,
  provider: enumOf(PROVIDER_NAMES),
  model: label.nullable(),
  briefHash: sha256,
  candidateHash: sha256.nullable(),
  startedAt: z.string().refine((s) => ISO_INSTANT.test(s) && !Number.isNaN(Date.parse(s))),
  totalDurationMs: z.number().min(0).max(MAX_DURATION_MS),
  requests: z.array(requestSchema).max(10),
  totalHttpAttempts: count(10 * MAX_ATTEMPTS),
  callBudget: z.object({
    maxRequests: count(100),
    maxHttpAttempts: count(MAX_ATTEMPTS),
  }),
});

const failureBase = {
  approved: z.literal(false),
  publication: z.literal('NOT_PUBLISHED'),
  candidateFile: z.null(),
  provenance: provenanceSchema,
};

const validationReportSchema = z.object({
  status: z.literal('REVIEW_REQUIRED'),
  approved: z.literal(false),
  editorialStatus: z.literal('UNREVIEWED'),
  publication: z.literal('NOT_PUBLISHED'),
  mechanicalValidity: z.literal('passed'),
  candidate: z.object({ hash: sha256 }),
  repaired: z.boolean(),
  // The whole pipeline, in order: a REVIEW_REQUIRED report that skipped a stage is not trusted.
  stages: z
    .array(z.object({ stage: enumOf(VALIDATION_STAGES), passed: z.literal(true) }))
    .refine((stages) => stages.map((s) => s.stage).join() === VALIDATION_STAGES.join()),
  provenance: provenanceSchema,
});

const runReportSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('REJECTED'),
    ...failureBase,
    failedStage: enumOf(VALIDATION_STAGES),
    repair: enumOf(REPAIR_DISPOSITIONS),
  }),
  z.object({
    status: z.literal('STOPPED'),
    ...failureBase,
    stopReason: enumOf(STOP_REASONS),
    phase: z.enum(['generate', 'repair']),
  }),
]);

type Provenance = z.infer<typeof provenanceSchema>;
type RequestRecord = z.infer<typeof requestSchema>;
type ValidationReport = z.infer<typeof validationReportSchema>;
type RunReport = z.infer<typeof runReportSchema>;

// ── Parsing ─────────────────────────────────────────────────────────────────

const invalid = (code: ReportErrorCode, detail: string): ParseOutcome => ({
  ok: false,
  code,
  detail,
});

function toValidation(value: string | undefined): RequestValidation | null {
  if (value === undefined) return null;
  if (value === 'passed') return { verdict: 'passed' };
  return { verdict: 'failed', stage: value.slice('failed:'.length) as ValidationStage };
}

function toRequest(r: RequestRecord): RequestObservation {
  return {
    phase: r.phase,
    outcome: r.outcome as 'ok' | StopReason,
    httpAttempts: r.httpAttempts,
    durationMs: r.durationMs,
    inputTokens: r.inputTokens ?? null,
    outputTokens: r.outputTokens ?? null,
    validation: toValidation(r.validation),
  };
}

function toObservation(
  status: RunObservation['status'],
  p: Provenance,
  extra: Partial<RunObservation>,
): RunObservation {
  return {
    status,
    group: {
      provider: p.provider,
      model: p.model,
      promptVersion: p.promptVersion,
      wireSchemaVersion: p.schemaVersion,
      briefHash: p.briefHash,
    },
    repaired: false,
    rejectedStage: null,
    repairDisposition: null,
    stopReason: null,
    stopPhase: null,
    requests: p.requests.map(toRequest),
    totalHttpAttempts: p.totalHttpAttempts,
    totalDurationMs: p.totalDurationMs,
    ...extra,
  };
}

const PHASE_ORDER: readonly DraftRequestKind[] = ['generate', 'repair'];
const ABORT_REASONS: readonly StopReason[] = ['CANCELLED', 'DEADLINE_EXCEEDED'];

/** Checks that hold for every outcome. Returns a fixed detail id, or null when consistent. */
function commonTelemetryProblem(p: Provenance): string | null {
  if (p.requests.length > p.callBudget.maxRequests) return 'request-budget';
  if (p.requests.some((r, i) => r.phase !== PHASE_ORDER[i])) return 'request-phases';
  if ((p.provider === 'openai') !== (p.model !== null)) return 'provider-model';
  if (p.requests.reduce((sum, r) => sum + r.httpAttempts, 0) !== p.totalHttpAttempts) {
    return 'http-attempts-sum';
  }
  if (
    p.provider === 'mock' &&
    p.requests.some(
      (r) => r.httpAttempts !== 0 || r.inputTokens !== undefined || r.outputTokens !== undefined,
    )
  ) {
    return 'mock-telemetry';
  }
  if (p.requests.reduce((sum, r) => sum + r.durationMs, 0) > p.totalDurationMs) {
    return 'duration-total';
  }
  return null;
}

const isFailed = (r: RequestRecord): boolean =>
  r.outcome === 'ok' && r.validation !== undefined && r.validation !== 'passed';

function validationReportProblem(report: ValidationReport): string | null {
  const { requests } = report.provenance;
  const last = requests[requests.length - 1];
  if (!last || requests.some((r) => r.outcome !== 'ok')) return 'request-validation';
  if (last.validation !== 'passed' || !requests.slice(0, -1).every(isFailed)) {
    return 'request-validation';
  }
  if (report.repaired !== (last.phase === 'repair')) return 'repaired-flag';
  if (report.provenance.candidateHash !== report.candidate.hash) return 'candidate-hash';
  if (report.provenance.totalHttpAttempts > report.provenance.callBudget.maxHttpAttempts) {
    return 'http-budget';
  }
  return null;
}

function runReportProblem(report: RunReport): string | null {
  const p = report.provenance;
  const { requests } = p;
  const last = requests[requests.length - 1];
  if (p.candidateHash !== null) return 'candidate-hash';

  if (report.status === 'REJECTED') {
    if (!last || !requests.slice(0, -1).every(isFailed)) return 'request-validation';
    if (last.outcome !== 'ok' || last.validation !== `failed:${report.failedStage}`) {
      return 'request-validation';
    }
    const attempted = report.repair === 'attempted';
    if (attempted ? requests.length !== 2 : requests.length !== 1) return 'repair-disposition';
    if (p.totalHttpAttempts > p.callBudget.maxHttpAttempts) return 'http-budget';
    return null;
  }

  // STOPPED: either the request of `phase` ended in the stop, or the run was
  // aborted before that request was dispatched.
  const dispatched = report.phase === 'generate' ? 1 : 2;
  const beforeDispatch = dispatched - 1;
  const abortedBeforeDispatch = requests.length === beforeDispatch;
  if (requests.length !== dispatched && !abortedBeforeDispatch) return 'stop-phase';
  if (abortedBeforeDispatch && !ABORT_REASONS.includes(report.stopReason)) return 'stop-phase';

  const prior = abortedBeforeDispatch ? requests : requests.slice(0, -1);
  if (!abortedBeforeDispatch && last && last.outcome !== report.stopReason) return 'stop-outcome';
  if (!prior.every(isFailed)) return 'request-validation';
  if (!abortedBeforeDispatch && last && last.validation !== undefined) return 'request-validation';
  if (
    report.stopReason === 'CALL_BUDGET_EXCEEDED' &&
    p.totalHttpAttempts <= p.callBudget.maxHttpAttempts
  ) {
    return 'http-budget';
  }
  return null;
}

const pathOf = (issuePath: ReadonlyArray<string | number>): string =>
  issuePath.length === 0 ? 'root' : issuePath.join('.');

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export function parseRunReport(fileName: ReportFileName, text: string): ParseOutcome {
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch {
    return invalid('MALFORMED_JSON', 'json');
  }
  if (!isRecord(raw)) return invalid('SCHEMA_INVALID', 'root');

  const expectsValidation = fileName === 'validation-report.json';
  const status = raw['status'];
  if (expectsValidation && (status === 'REJECTED' || status === 'STOPPED')) {
    return invalid('KIND_MISMATCH', 'status');
  }
  if (!expectsValidation && status === 'REVIEW_REQUIRED') {
    return invalid('KIND_MISMATCH', 'status');
  }

  if (expectsValidation) {
    const result = validationReportSchema.safeParse(raw);
    if (!result.success) return invalid('SCHEMA_INVALID', pathOf(result.error.issues[0]!.path));
    const problem =
      commonTelemetryProblem(result.data.provenance) ?? validationReportProblem(result.data);
    if (problem) return invalid('INCONSISTENT_TELEMETRY', problem);
    return {
      ok: true,
      observation: toObservation('REVIEW_REQUIRED', result.data.provenance, {
        repaired: result.data.repaired,
      }),
    };
  }

  const result = runReportSchema.safeParse(raw);
  if (!result.success) return invalid('SCHEMA_INVALID', pathOf(result.error.issues[0]!.path));
  const report = result.data;
  const problem = commonTelemetryProblem(report.provenance) ?? runReportProblem(report);
  if (problem) return invalid('INCONSISTENT_TELEMETRY', problem);
  return {
    ok: true,
    observation:
      report.status === 'REJECTED'
        ? toObservation('REJECTED', report.provenance, {
            rejectedStage: report.failedStage,
            repairDisposition: report.repair,
          })
        : toObservation('STOPPED', report.provenance, {
            stopReason: report.stopReason,
            stopPhase: report.phase,
          }),
  };
}
