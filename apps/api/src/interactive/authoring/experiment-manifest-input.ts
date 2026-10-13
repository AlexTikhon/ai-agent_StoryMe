import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import {
  deriveBudget,
  EXECUTION_POLICY,
  EXPERIMENT_MANIFEST_SCHEMA,
  summarizeObservation,
  type EntryStatus,
  type ExperimentManifest,
  type HaltKind,
  type IncompleteReason,
  type ManifestEntry,
} from './experiment';
import { REPORT_FILE_NAMES, type ReportFileName } from './run-report-input';

/**
 * Parsing and consistency checking of a saved experiment manifest
 * (`interactive-authoring-experiment-manifest/v2`). Pure: text in, a typed
 * manifest plus the artifact references it makes, or stable issue codes out. No
 * filesystem, provider, database or network.
 *
 * It trusts nothing in the file: the schema is strict (an unknown key is an
 * error, not noise), every count is recomputed from the entries with the
 * runner's own `summarizeObservation`, and unknown usage stays unknown (it is
 * never read as zero). Issue records carry only a fixed code, an entry key that
 * passed an identifier pattern and, for schema errors, a path made of schema
 * keys; never a value taken from the input, so nothing the file says is echoed.
 *
 * A passing check says the checkpoint is internally consistent. It says nothing
 * about billing, editorial approval or whether any process is still working.
 */

export const MAX_MANIFEST_BYTES = 1024 * 1024;
export const MAX_ENTRIES = 16;
export const MAX_FILES_PER_ENTRY = 16;
const MAX_REFERENCE_LENGTH = 200;
const COMPARISON_REPORT_FILE = 'comparison-report.json';

export const ISSUE_CODES = [
  'MANIFEST_UNREADABLE',
  'MANIFEST_TOO_LARGE',
  'MALFORMED_JSON',
  'SCHEMA_UNSUPPORTED',
  'SCHEMA_INVALID',
  'BOUND_EXCEEDED',
  'DUPLICATE_ENTRY_IDENTITY',
  'CONFIGURATION_INCONSISTENT',
  'ENTRY_STATE_ILLEGAL',
  'ENTRY_ORDER_ILLEGAL',
  'CHECKPOINT_INCONSISTENT',
  'COMPLETENESS_MISMATCH',
  'HALT_INCONSISTENT',
  'OBSERVED_TOTALS_MISMATCH',
  'COVERAGE_MISMATCH',
  'WITHIN_BUDGET_MISMATCH',
  'REFERENCE_INVALID',
  'ARTIFACT_MISSING',
  'ARTIFACT_NOT_A_FILE',
  'ARTIFACT_ESCAPES_DIRECTORY',
  'ARTIFACT_UNREADABLE',
  'ARTIFACT_TOO_LARGE',
  'RUN_REPORT_INVALID',
  'RUN_REPORT_BRIEF_HASH_MISMATCH',
  'RUN_REPORT_PROVIDER_MISMATCH',
  'RUN_REPORT_VERSION_MISMATCH',
  'RUN_REPORT_OUTCOME_MISMATCH',
  'RUN_REPORT_REQUEST_COUNT_MISMATCH',
] as const;
export type IssueCode = (typeof ISSUE_CODES)[number];

export interface InspectIssue {
  code: IssueCode;
  /** A corpus entry key (identifier pattern enforced by the schema). */
  entry?: string;
  /** SCHEMA_INVALID only: a path of schema keys and indexes. */
  path?: string;
}

export interface EntryReferences {
  key: string;
  /** Run artifacts, as validated path segments relative to the experiment directory. */
  run: { dir: string[]; reportFile: ReportFileName; files: string[] } | null;
  routeReviewFiles: string[][];
}

export interface ReferencePlan {
  entries: EntryReferences[];
  comparisonReport: string[] | null;
}

export type ManifestParseOutcome =
  | { ok: true; manifest: ExperimentManifest; references: ReferencePlan }
  | { ok: false; issues: InspectIssue[] };

// ── Schema ──────────────────────────────────────────────────────────────────

const LABEL = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,99}$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const CODE = /^[A-Z][A-Z0-9_]{0,63}$/;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const MAX_COUNT = 1e9;

// Exhaustive records: a new member of a production union is a type error here.
const HALT_KIND_SET: Record<HaltKind, true> = {
  PROVIDER_STOP: true,
  CANCELLED: true,
  ARTIFACT_WRITE_FAILED: true,
  CHECKPOINT_WRITE_FAILED: true,
  BRIEF_REJECTED: true,
};
const HALT_KINDS = Object.keys(HALT_KIND_SET) as HaltKind[];
const REASON_SET: Record<IncompleteReason, true> = {
  ...HALT_KIND_SET,
  ROUTE_REVIEW_FAILED: true,
  COMPARISON_UNAVAILABLE: true,
  IN_PROGRESS: true,
};
const REASONS = Object.keys(REASON_SET) as IncompleteReason[];
const ENTRY_STATUS_SET: Record<EntryStatus, true> = {
  unattempted: true,
  awaiting_response: true,
  recording: true,
  completed: true,
  stopped: true,
};
const ENTRY_STATUSES = Object.keys(ENTRY_STATUS_SET) as EntryStatus[];
const KEY_SET: Record<ManifestEntry['key'], true> = {
  'last-tram': true,
  'harbour-ledger': true,
  'clock-blackout': true,
};
const ENTRY_KEYS = Object.keys(KEY_SET) as Array<ManifestEntry['key']>;

const enumOf = <T extends string>(values: readonly T[]) => z.enum(values as unknown as [T, ...T[]]);
const count = z.number().int().min(0).max(MAX_COUNT);
const label = z.string().regex(LABEL);
const code = z.string().regex(CODE);
const reference = z.string().max(MAX_REFERENCE_LENGTH);
// Prose fields are length-checked and never copied anywhere.
const prose = z.string().max(2000);

const stopSchema = z.object({ kind: enumOf(HALT_KINDS), reason: code.nullable() }).strict();

const routeReviewSchema = z.discriminatedUnion('status', [
  z
    .object({ status: z.literal('EXPORTED'), files: z.array(reference).max(MAX_FILES_PER_ENTRY) })
    .strict(),
  z.object({ status: z.literal('FAILED'), code }).strict(),
  z.object({ status: z.literal('WRITE_FAILED') }).strict(),
]);

const entrySchema = z
  .object({
    key: enumOf(ENTRY_KEYS),
    scenarioId: z.string().regex(IDENTIFIER),
    version: z.number().int().min(1).max(MAX_COUNT),
    briefHash: z.string().regex(SHA256),
    status: enumOf(ENTRY_STATUSES),
    outcome: enumOf(['REVIEW_REQUIRED', 'REJECTED', 'STOPPED'] as const).nullable(),
    stop: stopSchema.nullable(),
    repaired: z.boolean().nullable(),
    requests: count.nullable(),
    httpAttempts: count.nullable(),
    usage: enumOf(['REPORTED', 'UNKNOWN', 'NONE'] as const),
    artifacts: z
      .object({
        dir: reference,
        reportFile: enumOf(REPORT_FILE_NAMES),
        files: z.array(reference),
      })
      .strict()
      .nullable(),
    routeReview: routeReviewSchema.nullable(),
    approval: z.literal('PENDING').nullable(),
  })
  .strict();

const budgetSchema = z
  .object({
    briefs: count,
    perBrief: z
      .object({
        maxRequests: count,
        maxHttpAttempts: count,
        maxOutputTokens: count,
        maxRuntimeMs: count,
      })
      .strict(),
    maxRequests: count,
    maxHttpAttempts: count,
    maxOutputTokens: count,
    maxRuntimeMs: count,
    transportRetries: z.literal(0),
    concurrency: z.literal(1),
  })
  .strict();

const limitsSchema = z
  .object({
    maxOutputTokens: z.number().int().min(1).max(MAX_COUNT),
    requestTimeoutMs: z.number().int().min(1).max(MAX_COUNT),
    deadlineMs: z.number().int().min(1).max(MAX_COUNT),
  })
  .strict();

const manifestSchema = z
  .object({
    schema: z.literal(EXPERIMENT_MANIFEST_SCHEMA),
    mode: enumOf(['offline', 'openai'] as const),
    createdAt: z.string().refine((s) => ISO_INSTANT.test(s) && !Number.isNaN(Date.parse(s))),
    evidence: z
      .object({
        class: enumOf(['HARNESS_VERIFICATION_ONLY', 'OPENAI_OBSERVATIONS_UNVERIFIED'] as const),
        note: prose,
      })
      .strict(),
    configuration: z
      .object({
        corpusVersion: label,
        promptVersion: label,
        wireSchemaVersion: label,
        provider: enumOf(['scripted', 'openai'] as const),
        model: label.nullable(),
        limits: limitsSchema,
        budget: budgetSchema,
        executionPolicy: z.object({}).passthrough(),
      })
      .strict(),
    checkpoint: z
      .object({
        state: enumOf(['IN_PROGRESS', 'FINAL'] as const),
        sequence: z.number().int().min(1).max(MAX_COUNT),
      })
      .strict(),
    completeness: z
      .object({
        status: enumOf(['COMPLETE', 'INCOMPLETE'] as const),
        reasons: z.array(enumOf(REASONS)).max(REASONS.length * 2),
        total: count,
        completed: count,
        stopped: count,
        unattempted: count,
        awaitingResponse: count,
        recording: count,
      })
      .strict(),
    halt: z
      .object({
        kind: enumOf(HALT_KINDS),
        entry: enumOf(ENTRY_KEYS).nullable(),
        reason: code.nullable(),
      })
      .strict()
      .nullable(),
    observed: z
      .object({
        requests: count,
        httpAttempts: count,
        coverage: z
          .object({
            status: enumOf(['COMPLETE', 'PARTIAL'] as const),
            reported: count,
            unknown: count,
            notDispatched: count,
          })
          .strict(),
        withinBudget: z.boolean().nullable(),
      })
      .strict(),
    entries: z.array(entrySchema).min(1),
    comparisonReport: reference.nullable(),
    notEvidenceOf: z.array(prose).max(16),
  })
  .strict();

type ParsedManifest = z.infer<typeof manifestSchema>;
type ParsedEntry = ParsedManifest['entries'][number];

// ── Helpers ─────────────────────────────────────────────────────────────────

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const SEGMENT = /^[A-Za-z0-9._@+-]+$/;
const RESERVED_DEVICE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/**
 * A reference is a relative path of plain segments with `/` separators: no
 * absolute or drive-qualified form, no backslash or colon, no empty, `.` or `..`
 * segment, no trailing dot (Windows aliases it) and no device name. Anything
 * else is refused before the filesystem is consulted.
 */
export function parseReference(value: string): string[] | null {
  if (value.length === 0 || value.length > MAX_REFERENCE_LENGTH) return null;
  const segments = value.split('/');
  for (const segment of segments) {
    if (!SEGMENT.test(segment)) return null;
    if (segment === '.' || segment === '..' || segment.endsWith('.')) return null;
    if (RESERVED_DEVICE.test(segment)) return null;
  }
  return segments;
}

class IssueSet {
  private readonly seen = new Set<string>();
  readonly list: InspectIssue[] = [];
  add(issueCode: IssueCode, entry?: string): void {
    const id = `${issueCode}:${entry ?? ''}`;
    if (this.seen.has(id)) return;
    this.seen.add(id);
    this.list.push(entry === undefined ? { code: issueCode } : { code: issueCode, entry });
  }
}

const hasCounts = (e: ParsedEntry) => e.requests !== null && e.httpAttempts !== null;
const noResult = (e: ParsedEntry) =>
  e.outcome === null &&
  e.stop === null &&
  e.repaired === null &&
  e.requests === null &&
  e.httpAttempts === null &&
  e.artifacts === null &&
  e.routeReview === null &&
  e.approval === null;

/** Counts exist exactly when usage was reported; unknown usage is never a number. */
function usageIsCoherent(e: ParsedEntry): boolean {
  return e.usage === 'REPORTED' ? hasCounts(e) : e.requests === null && e.httpAttempts === null;
}

function resultFieldsLegal(e: ParsedEntry): boolean {
  if (e.outcome === 'REVIEW_REQUIRED') {
    if (e.repaired === null) return false;
    // Accepted from the repair request: that means a second request was made.
    return !e.repaired || (e.requests !== null && e.requests >= 2);
  }
  return e.repaired === null;
}

function artifactsLegal(e: ParsedEntry): boolean {
  if (e.artifacts === null) {
    return e.routeReview === null && e.approval === null;
  }
  if (e.usage !== 'REPORTED' || e.outcome === null) return false;
  const { reportFile, files } = e.artifacts;
  if (
    reportFile !== (e.outcome === 'REVIEW_REQUIRED' ? 'validation-report.json' : 'run-report.json')
  ) {
    return false;
  }
  if (!files.includes(reportFile) || new Set(files).size !== files.length) return false;
  if (e.approval !== (files.includes('approval-template.json') ? 'PENDING' : null)) return false;
  if (e.routeReview !== null && e.outcome !== 'REVIEW_REQUIRED') return false;
  return true;
}

function entryIsLegal(e: ParsedEntry, state: ParsedManifest['checkpoint']['state']): boolean {
  if (!usageIsCoherent(e)) return false;
  const inProgress = state === 'IN_PROGRESS';
  switch (e.status) {
    case 'unattempted':
      return e.usage === 'NONE' && noResult(e);
    case 'awaiting_response':
      return inProgress && e.usage === 'UNKNOWN' && noResult(e);
    case 'recording': {
      if (!inProgress || e.usage !== 'REPORTED' || e.outcome === null) return false;
      if (e.artifacts !== null || e.routeReview !== null || e.approval !== null) return false;
      if (!resultFieldsLegal(e)) return false;
      return e.outcome === 'STOPPED'
        ? e.stop !== null && (e.stop.kind === 'PROVIDER_STOP' || e.stop.kind === 'CANCELLED')
        : e.stop === null;
    }
    case 'completed': {
      if (e.usage !== 'REPORTED' || e.stop !== null) return false;
      if (e.outcome !== 'REVIEW_REQUIRED' && e.outcome !== 'REJECTED') return false;
      if (!resultFieldsLegal(e) || e.artifacts === null || !artifactsLegal(e)) return false;
      if (e.outcome === 'REVIEW_REQUIRED') {
        return e.routeReview !== null && e.routeReview.status !== 'WRITE_FAILED';
      }
      return e.routeReview === null;
    }
    case 'stopped': {
      if (e.stop === null) return false;
      if (!resultFieldsLegal(e) || !artifactsLegal(e)) return false;
      const kind = e.stop.kind;
      if (e.outcome === 'STOPPED') {
        if (kind !== 'PROVIDER_STOP' && kind !== 'CANCELLED') return false;
        // Counts, or (an unexpected harness failure) usage that stays unknown.
        return e.usage === 'REPORTED' || (e.usage === 'UNKNOWN' && kind === 'PROVIDER_STOP');
      }
      if (e.outcome === 'REVIEW_REQUIRED' || e.outcome === 'REJECTED') {
        return (
          e.usage === 'REPORTED' &&
          (kind === 'ARTIFACT_WRITE_FAILED' || kind === 'CHECKPOINT_WRITE_FAILED')
        );
      }
      // No result: the brief was refused, or its in-flight checkpoint could not be
      // written so nothing was dispatched.
      return (
        e.usage === 'NONE' &&
        (kind === 'BRIEF_REJECTED' || kind === 'CHECKPOINT_WRITE_FAILED') &&
        e.artifacts === null
      );
    }
  }
}

// ── Consistency ─────────────────────────────────────────────────────────────

function checkConsistency(m: ParsedManifest, issues: IssueSet): void {
  const { entries, configuration, checkpoint, completeness, halt } = m;
  const state = checkpoint.state;
  const reasons = completeness.reasons;

  // Identities.
  const keys = new Set<string>();
  const scenarios = new Set<string>();
  const hashes = new Set<string>();
  for (const e of entries) {
    const scenario = `${e.scenarioId}@${e.version}`;
    if (keys.has(e.key) || scenarios.has(scenario) || hashes.has(e.briefHash)) {
      issues.add('DUPLICATE_ENTRY_IDENTITY', e.key);
    }
    keys.add(e.key);
    scenarios.add(scenario);
    hashes.add(e.briefHash);
  }

  // Configuration.
  const openai = m.mode === 'openai';
  if (
    configuration.provider !== (openai ? 'openai' : 'scripted') ||
    (configuration.model !== null) !== openai ||
    m.evidence.class !==
      (openai ? 'OPENAI_OBSERVATIONS_UNVERIFIED' : 'HARNESS_VERIFICATION_ONLY') ||
    !isDeepStrictEqual(configuration.budget, deriveBudget(entries.length, configuration.limits)) ||
    !isDeepStrictEqual(configuration.executionPolicy, EXECUTION_POLICY)
  ) {
    issues.add('CONFIGURATION_INCONSISTENT');
  }

  // Entries.
  for (const e of entries) {
    if (!entryIsLegal(e, state)) issues.add('ENTRY_STATE_ILLEGAL', e.key);
  }
  // The runner is sequential and halts at the first unresolved entry: settled
  // entries, then at most one unresolved or stopped entry, then unattempted ones.
  let phase: 'settled' | 'open' | 'tail' = 'settled';
  for (const e of entries) {
    if (e.status === 'completed') {
      if (phase !== 'settled') issues.add('ENTRY_ORDER_ILLEGAL', e.key);
    } else if (e.status === 'unattempted') {
      phase = 'tail';
    } else {
      if (phase !== 'settled') issues.add('ENTRY_ORDER_ILLEGAL', e.key);
      phase = phase === 'settled' ? 'open' : phase;
    }
  }

  // Checkpoint state versus completeness.
  const tally = (status: EntryStatus) => entries.filter((e) => e.status === status).length;
  const derived = {
    total: entries.length,
    completed: tally('completed'),
    stopped: tally('stopped'),
    unattempted: tally('unattempted'),
    awaitingResponse: tally('awaiting_response'),
    recording: tally('recording'),
  };
  if (
    completeness.total !== derived.total ||
    completeness.completed !== derived.completed ||
    completeness.stopped !== derived.stopped ||
    completeness.unattempted !== derived.unattempted ||
    completeness.awaitingResponse !== derived.awaitingResponse ||
    completeness.recording !== derived.recording
  ) {
    issues.add('COMPLETENESS_MISMATCH');
  }

  const inProgressReason = reasons.includes('IN_PROGRESS');
  if (new Set(reasons).size !== reasons.length) issues.add('CHECKPOINT_INCONSISTENT');
  if (state === 'IN_PROGRESS') {
    if (completeness.status !== 'INCOMPLETE' || !inProgressReason || m.comparisonReport !== null) {
      issues.add('CHECKPOINT_INCONSISTENT');
    }
  } else {
    const complete = reasons.length === 0 && derived.completed === derived.total;
    if (inProgressReason || completeness.status !== (complete ? 'COMPLETE' : 'INCOMPLETE')) {
      issues.add('CHECKPOINT_INCONSISTENT');
    }
  }
  for (const e of entries) {
    if (e.stop !== null && !reasons.includes(e.stop.kind))
      issues.add('CHECKPOINT_INCONSISTENT', e.key);
    if (e.routeReview?.status === 'FAILED' && !reasons.includes('ROUTE_REVIEW_FAILED')) {
      issues.add('CHECKPOINT_INCONSISTENT', e.key);
    }
  }

  // Halt information.
  // An entry that carries a stop (stopped, or a checkpointed `recording` entry whose
  // STOPPED result is durable) can only exist because the runner halted.
  const anyStopped = entries.some((e) => e.status === 'stopped' || e.stop !== null);
  if (anyStopped && halt === null) issues.add('HALT_INCONSISTENT');
  if (state === 'FINAL' && halt === null && derived.completed !== derived.total) {
    issues.add('HALT_INCONSISTENT');
  }
  if (halt !== null) {
    if (!reasons.includes(halt.kind)) issues.add('HALT_INCONSISTENT');
    if (halt.entry !== null) {
      const halted = entries.find((e) => e.key === halt.entry);
      // The runner sets the halt before it checkpoints the STOPPED result as
      // `recording`, and only a FINAL manifest has settled that entry to `stopped`.
      const haltable =
        halted !== undefined &&
        (halted.status === 'stopped' ||
          (state === 'IN_PROGRESS' &&
            halted.status === 'recording' &&
            halted.outcome === 'STOPPED'));
      if (
        !haltable ||
        halted.stop === null ||
        halted.stop.kind !== halt.kind ||
        halted.stop.reason !== halt.reason
      ) {
        issues.add('HALT_INCONSISTENT');
      }
    }
  }

  // Observed totals, coverage and budget claim, recomputed by the runner's own summary.
  const expected = summarizeObservation(
    entries as unknown as ManifestEntry[],
    configuration.budget,
    state,
  );
  const observed = m.observed;
  if (observed.requests !== expected.requests || observed.httpAttempts !== expected.httpAttempts) {
    issues.add('OBSERVED_TOTALS_MISMATCH');
  }
  if (!isDeepStrictEqual(observed.coverage, expected.coverage)) issues.add('COVERAGE_MISMATCH');
  if (observed.withinBudget !== expected.withinBudget) issues.add('WITHIN_BUDGET_MISMATCH');
}

// ── References ──────────────────────────────────────────────────────────────

function planReferences(m: ParsedManifest, issues: IssueSet): ReferencePlan {
  const entries: EntryReferences[] = [];
  for (const e of m.entries) {
    const plan: EntryReferences = { key: e.key, run: null, routeReviewFiles: [] };
    if (e.artifacts !== null) {
      const dir = parseReference(e.artifacts.dir);
      const files = e.artifacts.files.map((file) => {
        const segments = parseReference(file);
        return segments !== null && segments.length === 1 ? segments[0]! : null;
      });
      if (dir === null || files.some((f) => f === null)) issues.add('REFERENCE_INVALID', e.key);
      else {
        plan.run = {
          dir,
          reportFile: e.artifacts.reportFile,
          files: files as string[],
        };
      }
    }
    if (e.routeReview?.status === 'EXPORTED') {
      const expected = [`route-reviews/${e.key}.json`, `route-reviews/${e.key}.md`];
      const parsed = expected.map((file) => parseReference(file));
      if (!isDeepStrictEqual(e.routeReview.files, expected) || parsed.some((p) => p === null)) {
        issues.add('REFERENCE_INVALID', e.key);
      } else plan.routeReviewFiles = parsed as string[][];
    }
    entries.push(plan);
  }

  let comparisonReport: string[] | null = null;
  if (m.comparisonReport !== null) {
    if (
      m.comparisonReport !== COMPARISON_REPORT_FILE ||
      parseReference(m.comparisonReport) === null
    ) {
      issues.add('REFERENCE_INVALID');
    } else comparisonReport = [COMPARISON_REPORT_FILE];
  }
  return { entries, comparisonReport };
}

// ── Entry point ─────────────────────────────────────────────────────────────

const failure = (...found: InspectIssue[]): ManifestParseOutcome => ({ ok: false, issues: found });

const schemaPath = (issuePath: ReadonlyArray<string | number>): string =>
  issuePath.length === 0 ? 'root' : issuePath.join('.');

export function parseExperimentManifest(text: string): ManifestParseOutcome {
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch {
    return failure({ code: 'MALFORMED_JSON' });
  }
  if (!isRecord(raw)) return failure({ code: 'SCHEMA_INVALID', path: 'root' });
  const declared = raw['schema'];
  if (typeof declared === 'string' && declared !== EXPERIMENT_MANIFEST_SCHEMA) {
    return failure({ code: 'SCHEMA_UNSUPPORTED' });
  }

  const parsed = manifestSchema.safeParse(raw);
  if (!parsed.success) {
    return failure({ code: 'SCHEMA_INVALID', path: schemaPath(parsed.error.issues[0]!.path) });
  }
  const manifest = parsed.data;

  if (
    manifest.entries.length > MAX_ENTRIES ||
    manifest.entries.some(
      (e) =>
        (e.artifacts?.files.length ?? 0) > MAX_FILES_PER_ENTRY ||
        (e.routeReview?.status === 'EXPORTED' ? e.routeReview.files.length : 0) >
          MAX_FILES_PER_ENTRY,
    )
  ) {
    return failure({ code: 'BOUND_EXCEEDED' });
  }

  const issues = new IssueSet();
  checkConsistency(manifest, issues);
  const references = planReferences(manifest, issues);
  if (issues.list.length > 0) return { ok: false, issues: issues.list };
  return { ok: true, manifest: manifest as unknown as ExperimentManifest, references };
}
