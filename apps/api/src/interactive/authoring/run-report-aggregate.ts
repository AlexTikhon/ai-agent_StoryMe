import { VALIDATION_STAGES, type ValidationStage } from './diagnostics';
import type { StopReason } from './pipeline';
import { STOP_REASONS, type RunGroupKey, type RunObservation } from './run-report-input';

/**
 * Aggregation of already-parsed run observations into a versioned, allowlisted
 * comparison report. Pure and order-independent: the same observations in any
 * order give byte-identical output.
 *
 * Nothing here estimates. A rate with an empty denominator is `null`, a token
 * total nobody reported is `null`, and no cost is ever computed. Mechanical
 * validity is a count of runs that passed the deterministic validation stages;
 * it says nothing about editorial quality.
 */

export const COMPARISON_REPORT_SCHEMA = 'interactive-authoring-run-comparison/v1';

export type EvidenceClass = 'OFFLINE_MOCK' | 'OFFLINE_SCRIPTED' | 'OPENAI_LABELLED';

export interface Rate {
  /** numerator / denominator rounded to 4 decimals; null when the denominator is 0. */
  rate: number | null;
}

export interface TokenUsageSummary {
  /** Sum over requests that reported the value; null when no request did. */
  reportedTotal: number | null;
  requestsReporting: number;
  requestsObserved: number;
  /** requestsReporting / requestsObserved; null when no request was observed. */
  coverage: number | null;
  /** Every observed request reported it (false when nothing was observed). */
  complete: boolean;
}

export interface GroupSummary {
  key: RunGroupKey;
  evidenceClass: EvidenceClass;
  samples: number;
  outcomes: { reviewRequired: number; rejected: number; stopped: number };
  firstPass: { evaluated: number; passed: number; notEvaluated: number } & Rate;
  repair: {
    attempted: number;
    evaluated: number;
    succeeded: number;
    stoppedDuringRepair: number;
    skippedBudgetExhausted: number;
    successRate: number | null;
  };
  finalValidity: { evaluated: number; valid: number } & Rate;
  rejectionStages: Record<ValidationStage, number>;
  stopReasons: Record<StopReason, number>;
  providerRequests: number;
  httpAttempts: number;
  totalRunDurationMs: {
    samples: number;
    minMs: number | null;
    medianMs: number | null;
    maxMs: number | null;
    meanMs: number | null;
  };
  tokenUsage: { input: TokenUsageSummary; output: TokenUsageSummary };
}

export interface ComparisonReport {
  schema: typeof COMPARISON_REPORT_SCHEMA;
  evidenceLabel: 'OBSERVATIONS_FROM_SUPPLIED_ARTIFACTS';
  limitations: string[];
  definitions: Record<string, string>;
  inputs: { reports: number; groups: number };
  groups: GroupSummary[];
}

const LIMITATIONS = [
  'Observations from the supplied run reports only: counts and rates describe those artifacts, not a population, and carry no significance testing.',
  'Mechanical validity means the deterministic validation stages passed. It is not editorial approval, not a measure of prose quality and not publication readiness.',
  'A provider label does not prove a real paid call occurred: reports are not authenticated. Mock, scripted and OpenAI-labelled runs are grouped separately and none is independently verified.',
  'Token totals sum only usage the provider reported; unknown usage is never zero or estimated, and no cost is computed.',
  'Durations are the total-run durations recorded in each report, including scripted or mock timing; they are not latency benchmarks.',
  'Real-model quality remains unverified.',
] as const;

const DEFINITIONS: Record<string, string> = {
  outcomes: 'Valid supplied reports by final status; every supplied report is counted once.',
  firstPass:
    'evaluated = runs whose first (generate) candidate was validated; passed = of those, passed every stage; notEvaluated = runs that stopped before a first candidate was validated; rate = passed / evaluated.',
  repair:
    'attempted = repair requests dispatched; evaluated = repair candidates that were validated; succeeded = runs accepted from the repair candidate; stoppedDuringRepair = repair requests that ended in a stop; skippedBudgetExhausted = runs whose repair was not dispatched because the call budget was spent; successRate = succeeded / evaluated.',
  finalValidity:
    'evaluated = runs that ended with a validation verdict (REVIEW_REQUIRED or REJECTED); valid = REVIEW_REQUIRED; rate = valid / evaluated. STOPPED runs are outside this denominator and counted in outcomes.',
  providerRequests:
    'Request records in the reports; a mock request is recorded but sends no HTTP attempt.',
  httpAttempts: 'Sum of recorded HTTP attempts, retries included.',
  totalRunDurationMs:
    'Distribution of the recorded total run duration over all samples in the group.',
  tokenUsage:
    'reportedTotal sums requests that reported the value (null if none did); coverage = requestsReporting / requestsObserved.',
};

const EVIDENCE_BY_PROVIDER: Record<RunGroupKey['provider'], EvidenceClass> = {
  mock: 'OFFLINE_MOCK',
  scripted: 'OFFLINE_SCRIPTED',
  openai: 'OPENAI_LABELLED',
};

const round = (value: number, decimals: number): number => {
  const f = 10 ** decimals;
  return Math.round(value * f) / f;
};
const ratio = (numerator: number, denominator: number): number | null =>
  denominator === 0 ? null : round(numerator / denominator, 4);

function median(sortedAscending: readonly number[]): number {
  const mid = Math.floor(sortedAscending.length / 2);
  return sortedAscending.length % 2 === 1
    ? sortedAscending[mid]!
    : (sortedAscending[mid - 1]! + sortedAscending[mid]!) / 2;
}

function tokenSummary(values: ReadonlyArray<number | null>): TokenUsageSummary {
  const reported = values.filter((v): v is number => v !== null);
  return {
    reportedTotal: reported.length === 0 ? null : reported.reduce((a, b) => a + b, 0),
    requestsReporting: reported.length,
    requestsObserved: values.length,
    coverage: ratio(reported.length, values.length),
    complete: values.length > 0 && reported.length === values.length,
  };
}

function summarize(key: RunGroupKey, runs: readonly RunObservation[]): GroupSummary {
  const requests = runs.flatMap((r) => r.requests);
  const generate = runs.map((r) => r.requests.find((q) => q.phase === 'generate'));
  const repairs = requests.filter((q) => q.phase === 'repair');

  const firstPassEvaluated = generate.filter((q) => q?.validation != null).length;
  const firstPassPassed = generate.filter((q) => q?.validation?.verdict === 'passed').length;
  const repairEvaluated = repairs.filter((q) => q.validation !== null).length;
  const repairSucceeded = runs.filter((r) => r.status === 'REVIEW_REQUIRED' && r.repaired).length;
  const reviewRequired = runs.filter((r) => r.status === 'REVIEW_REQUIRED').length;
  const rejected = runs.filter((r) => r.status === 'REJECTED').length;
  const stopped = runs.filter((r) => r.status === 'STOPPED').length;

  const rejectionStages = Object.fromEntries(VALIDATION_STAGES.map((s) => [s, 0])) as Record<
    ValidationStage,
    number
  >;
  const stopReasons = Object.fromEntries(STOP_REASONS.map((s) => [s, 0])) as Record<
    StopReason,
    number
  >;
  for (const run of runs) {
    if (run.rejectedStage) rejectionStages[run.rejectedStage] += 1;
    if (run.stopReason) stopReasons[run.stopReason] += 1;
  }

  const durations = runs.map((r) => r.totalDurationMs).sort((a, b) => a - b);
  const durationTotal = durations.reduce((a, b) => a + b, 0);

  return {
    key,
    evidenceClass: EVIDENCE_BY_PROVIDER[key.provider],
    samples: runs.length,
    outcomes: { reviewRequired, rejected, stopped },
    firstPass: {
      evaluated: firstPassEvaluated,
      passed: firstPassPassed,
      notEvaluated: runs.length - firstPassEvaluated,
      rate: ratio(firstPassPassed, firstPassEvaluated),
    },
    repair: {
      attempted: repairs.length,
      evaluated: repairEvaluated,
      succeeded: repairSucceeded,
      stoppedDuringRepair: repairs.length - repairEvaluated,
      skippedBudgetExhausted: runs.filter((r) => r.repairDisposition === 'skipped_budget_exhausted')
        .length,
      successRate: ratio(repairSucceeded, repairEvaluated),
    },
    finalValidity: {
      evaluated: reviewRequired + rejected,
      valid: reviewRequired,
      rate: ratio(reviewRequired, reviewRequired + rejected),
    },
    rejectionStages,
    stopReasons,
    providerRequests: requests.length,
    httpAttempts: runs.reduce((sum, r) => sum + r.totalHttpAttempts, 0),
    totalRunDurationMs: {
      samples: durations.length,
      minMs: durations.length === 0 ? null : durations[0]!,
      medianMs: durations.length === 0 ? null : median(durations),
      maxMs: durations.length === 0 ? null : durations[durations.length - 1]!,
      meanMs: durations.length === 0 ? null : round(durationTotal / durations.length, 2),
    },
    tokenUsage: {
      input: tokenSummary(requests.map((q) => q.inputTokens)),
      output: tokenSummary(requests.map((q) => q.outputTokens)),
    },
  };
}

// Plain code-unit ordering: independent of locale and of the input order.
const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const sortKey = (k: RunGroupKey): string[] => [
  k.provider,
  k.model ?? '',
  k.promptVersion,
  k.wireSchemaVersion,
  k.briefHash,
];

function compareKeys(a: RunGroupKey, b: RunGroupKey): number {
  const left = sortKey(a);
  const right = sortKey(b);
  for (let i = 0; i < left.length; i += 1) {
    const order = compareText(left[i]!, right[i]!);
    if (order !== 0) return order;
  }
  return 0;
}

export function buildComparisonReport(observations: readonly RunObservation[]): ComparisonReport {
  const buckets = new Map<string, { key: RunGroupKey; runs: RunObservation[] }>();
  for (const run of observations) {
    const id = JSON.stringify(sortKey(run.group));
    const bucket = buckets.get(id);
    if (bucket) bucket.runs.push(run);
    else buckets.set(id, { key: run.group, runs: [run] });
  }
  const groups = [...buckets.values()]
    .sort((a, b) => compareKeys(a.key, b.key))
    .map((b) => summarize({ ...b.key }, b.runs));

  return {
    schema: COMPARISON_REPORT_SCHEMA,
    evidenceLabel: 'OBSERVATIONS_FROM_SUPPLIED_ARTIFACTS',
    limitations: [...LIMITATIONS],
    definitions: { ...DEFINITIONS },
    inputs: { reports: observations.length, groups: groups.length },
    groups,
  };
}
