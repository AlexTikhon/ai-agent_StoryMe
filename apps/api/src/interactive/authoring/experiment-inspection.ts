import {
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  type Stats,
} from 'node:fs';
import path from 'node:path';
import {
  EXPERIMENT_MANIFEST_SCHEMA,
  type EntryStatus,
  type EntryUsage,
  type ExperimentManifest,
  type ManifestEntry,
} from './experiment';
import {
  MAX_MANIFEST_BYTES,
  parseExperimentManifest,
  type EntryReferences,
  type InspectIssue,
  type IssueCode,
} from './experiment-manifest-input';
import { parseRunReport, type ReportFileName, type RunObservation } from './run-report-input';

/**
 * Read-only inspection of one saved experiment checkpoint.
 *
 * The pure parsing and consistency rules live in `experiment-manifest-input`;
 * this module adds the bounded filesystem reads for the artifacts the
 * checkpoint explicitly references and assembles an allowlisted result. It
 * never writes, never constructs a provider, never touches the network and never
 * lists a directory: only references recorded in the manifest are looked at, so
 * unreferenced artifacts are neither discovered nor recovered.
 *
 * Run reports are the only artifact content read (through `parseRunReport`);
 * candidate, review and route-review files are checked for existence only. The
 * result carries identifiers, enums, counts and fixed vocabulary: no absolute
 * path, prose, diagnostic message or raw exception.
 */

export const INSPECTION_SCHEMA = 'interactive-authoring-experiment-inspection/v1';
export const MAX_REPORT_BYTES = 256 * 1024;

export const EVIDENCE_LIMITS = [
  'Only the saved checkpoint and the artifacts it references were inspected; unreferenced files are neither discovered nor recovered.',
  'An IN_PROGRESS checkpoint is the last saved state. It does not show whether any process is active and does not show that any request failed or completed.',
  'Unknown usage stays unknown and known counts are a lower bound unless coverage is COMPLETE. This inspection does not establish billing.',
  'A valid inspection is not editorial approval and not evidence of prose quality; approval templates remain PENDING.',
  'Referenced candidate and review files were checked for existence only; their contents were not read.',
] as const;

export interface EntryInspection {
  key: ManifestEntry['key'];
  scenarioId: string;
  version: number;
  briefHash: string;
  status: EntryStatus;
  outcome: ManifestEntry['outcome'];
  usage: EntryUsage;
  /** Reported counts; null whenever usage is not REPORTED (never zero by default). */
  requests: number | null;
  httpAttempts: number | null;
  repaired: boolean | null;
  stop: ManifestEntry['stop'];
  approval: ManifestEntry['approval'];
  artifacts: {
    state: 'NOT_RECORDED' | 'VERIFIED';
    reportFile: ReportFileName | null;
    filesChecked: number;
    routeReview:
      'NOT_RECORDED' | 'FILES_PRESENT' | 'EXPORT_FAILURE_RECORDED' | 'WRITE_FAILURE_RECORDED';
  };
}

export interface Inspection {
  schema: typeof INSPECTION_SCHEMA;
  status: 'VALID';
  manifestSchema: typeof EXPERIMENT_MANIFEST_SCHEMA;
  mode: ExperimentManifest['mode'];
  evidenceClass: ExperimentManifest['evidence']['class'];
  provider: ExperimentManifest['configuration']['provider'];
  model: string | null;
  createdAt: string;
  versions: { corpus: string; prompt: string; wireSchema: string };
  pipelineLimits: ExperimentManifest['configuration']['limits'];
  budget: { briefs: number; maxRequests: number; maxHttpAttempts: number };
  checkpoint: ExperimentManifest['checkpoint'];
  completeness: ExperimentManifest['completeness'];
  halt: ExperimentManifest['halt'];
  observed: {
    requests: number;
    httpAttempts: number;
    /** True unless every entry's usage is accounted for in a FINAL manifest. */
    totalsAreLowerBound: boolean;
    coverage: ExperimentManifest['observed']['coverage'];
    withinBudget: boolean | null;
  };
  entries: EntryInspection[];
  artifactChecks: {
    entriesWithArtifacts: number;
    filesChecked: number;
    runReportsCompared: number;
    routeReviewFilesChecked: number;
    comparisonReport: 'NOT_RECORDED' | 'PRESENT';
  };
  /** Always empty here: an inspection with issues is reported as a failure instead. */
  issues: InspectIssue[];
  evidenceLimits: readonly string[];
}

export type InspectionOutcome =
  { ok: true; inspection: Inspection } | { ok: false; issues: InspectIssue[] };

// ── Bounded reads ───────────────────────────────────────────────────────────

type Read = { ok: true; text: string } | { ok: false; reason: 'unreadable' | 'too-large' };

/** The read itself is bounded whatever stat said, and only a regular file is read. */
function readBounded(file: string, maxBytes: number): Read {
  let fd: number | undefined;
  try {
    fd = openSync(file, 'r');
    const stat = fstatSync(fd);
    if (!stat.isFile()) return { ok: false, reason: 'unreadable' };
    if (stat.size > maxBytes) return { ok: false, reason: 'too-large' };
    const buffer = Buffer.alloc(maxBytes + 1);
    let length = 0;
    for (;;) {
      const read = readSync(fd, buffer, length, buffer.length - length, null);
      if (read === 0) break;
      length += read;
      if (length > maxBytes) return { ok: false, reason: 'too-large' };
    }
    return { ok: true, text: buffer.subarray(0, length).toString('utf8') };
  } catch {
    return { ok: false, reason: 'unreadable' };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

type Resolved =
  | { ok: true; full: string; stat: Stats }
  | { ok: false; code: 'ARTIFACT_MISSING' | 'ARTIFACT_ESCAPES_DIRECTORY' | 'ARTIFACT_UNREADABLE' };

const isMissing = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  ['ENOENT', 'ENOTDIR'].includes((error as { code?: string }).code ?? '');

const isWithin = (root: string, target: string): boolean => {
  const relative = path.relative(root, target);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
};

/**
 * Walks the reference one segment at a time from the real experiment directory.
 * A symbolic link or junction anywhere on the way is refused (not followed), and
 * the final real path must still lie inside the experiment directory.
 */
function resolveReference(rootReal: string, segments: readonly string[]): Resolved {
  let current = rootReal;
  let stat: Stats | undefined;
  for (const segment of segments) {
    current = path.join(current, segment);
    try {
      stat = lstatSync(current);
    } catch (error) {
      return { ok: false, code: isMissing(error) ? 'ARTIFACT_MISSING' : 'ARTIFACT_UNREADABLE' };
    }
    if (stat.isSymbolicLink()) return { ok: false, code: 'ARTIFACT_ESCAPES_DIRECTORY' };
  }
  try {
    if (!isWithin(rootReal, realpathSync(current))) {
      return { ok: false, code: 'ARTIFACT_ESCAPES_DIRECTORY' };
    }
  } catch (error) {
    return { ok: false, code: isMissing(error) ? 'ARTIFACT_MISSING' : 'ARTIFACT_UNREADABLE' };
  }
  return { ok: true, full: current, stat: stat! };
}

// ── Comparison with the manifest ────────────────────────────────────────────

function compareReport(
  entry: ManifestEntry,
  observation: RunObservation,
  configuration: ExperimentManifest['configuration'],
  add: (code: IssueCode) => void,
): void {
  if (observation.group.briefHash !== entry.briefHash) add('RUN_REPORT_BRIEF_HASH_MISMATCH');
  if (
    observation.group.provider !== configuration.provider ||
    observation.group.model !== configuration.model
  ) {
    add('RUN_REPORT_PROVIDER_MISMATCH');
  }
  if (
    observation.group.promptVersion !== configuration.promptVersion ||
    observation.group.wireSchemaVersion !== configuration.wireSchemaVersion
  ) {
    add('RUN_REPORT_VERSION_MISMATCH');
  }
  if (observation.status !== entry.outcome) add('RUN_REPORT_OUTCOME_MISMATCH');
  else if (observation.status === 'REVIEW_REQUIRED' && observation.repaired !== entry.repaired) {
    add('RUN_REPORT_OUTCOME_MISMATCH');
  } else if (
    observation.status === 'STOPPED' &&
    entry.stop !== null &&
    observation.stopReason !== entry.stop.reason
  ) {
    add('RUN_REPORT_OUTCOME_MISMATCH');
  }
  if (
    observation.requests.length !== entry.requests ||
    observation.totalHttpAttempts !== entry.httpAttempts
  ) {
    add('RUN_REPORT_REQUEST_COUNT_MISMATCH');
  }
}

// ── Inspection ──────────────────────────────────────────────────────────────

const fail = (...issues: InspectIssue[]): InspectionOutcome => ({ ok: false, issues });

export function inspectExperiment(manifestPath: string): InspectionOutcome {
  const manifestFile = path.resolve(manifestPath);

  let rootReal: string;
  try {
    // The manifest itself must be a plain file in the experiment directory.
    if (!lstatSync(manifestFile).isFile()) return fail({ code: 'MANIFEST_UNREADABLE' });
    rootReal = realpathSync(path.dirname(manifestFile));
  } catch {
    return fail({ code: 'MANIFEST_UNREADABLE' });
  }
  const read = readBounded(manifestFile, MAX_MANIFEST_BYTES);
  if (!read.ok) {
    return fail({
      code: read.reason === 'too-large' ? 'MANIFEST_TOO_LARGE' : 'MANIFEST_UNREADABLE',
    });
  }

  const parsed = parseExperimentManifest(read.text);
  if (!parsed.ok) return { ok: false, issues: parsed.issues };
  const { manifest, references } = parsed;

  const issues: InspectIssue[] = [];
  const seen = new Set<string>();
  const report = (code: IssueCode, entry?: string) => {
    const id = `${code}:${entry ?? ''}`;
    if (seen.has(id)) return;
    seen.add(id);
    issues.push(entry === undefined ? { code } : { code, entry });
  };

  const checks = {
    entriesWithArtifacts: 0,
    filesChecked: 0,
    runReportsCompared: 0,
    routeReviewFilesChecked: 0,
  };
  const perEntryFiles = new Map<string, number>();

  /** Existence and kind of one referenced regular file; returns its path when sound. */
  const checkFile = (segments: readonly string[], entry?: string): string | null => {
    const resolved = resolveReference(rootReal, segments);
    if (!resolved.ok) {
      report(resolved.code, entry);
      return null;
    }
    if (!resolved.stat.isFile()) {
      report('ARTIFACT_NOT_A_FILE', entry);
      return null;
    }
    return resolved.full;
  };

  manifest.entries.forEach((entry, index) => {
    const plan: EntryReferences = references.entries[index]!;
    if (plan.run !== null) {
      checks.entriesWithArtifacts += 1;
      const dir = resolveReference(rootReal, plan.run.dir);
      if (!dir.ok) report(dir.code, entry.key);
      else if (!dir.stat.isDirectory()) report('ARTIFACT_NOT_A_FILE', entry.key);
      else {
        let reportPath: string | null = null;
        let checked = 0;
        for (const file of plan.run.files) {
          const full = checkFile([...plan.run.dir, file], entry.key);
          if (full !== null) checked += 1;
          if (file === plan.run.reportFile) reportPath = full;
        }
        checks.filesChecked += checked;
        perEntryFiles.set(entry.key, checked);

        if (reportPath !== null) {
          const content = readBounded(reportPath, MAX_REPORT_BYTES);
          if (!content.ok) {
            report(
              content.reason === 'too-large' ? 'ARTIFACT_TOO_LARGE' : 'ARTIFACT_UNREADABLE',
              entry.key,
            );
          } else {
            const outcome = parseRunReport(plan.run.reportFile, content.text);
            if (!outcome.ok) report('RUN_REPORT_INVALID', entry.key);
            else {
              checks.runReportsCompared += 1;
              compareReport(entry, outcome.observation, manifest.configuration, (code) =>
                report(code, entry.key),
              );
            }
          }
        }
      }
    }
    for (const segments of plan.routeReviewFiles) {
      if (checkFile(segments, entry.key) !== null) checks.routeReviewFilesChecked += 1;
    }
  });

  let comparison: Inspection['artifactChecks']['comparisonReport'] = 'NOT_RECORDED';
  if (references.comparisonReport !== null) {
    if (checkFile(references.comparisonReport) !== null) comparison = 'PRESENT';
  }

  if (issues.length > 0) return { ok: false, issues };

  const { configuration, observed } = manifest;
  const inspection: Inspection = {
    schema: INSPECTION_SCHEMA,
    status: 'VALID',
    manifestSchema: manifest.schema,
    mode: manifest.mode,
    evidenceClass: manifest.evidence.class,
    provider: configuration.provider,
    model: configuration.model,
    createdAt: manifest.createdAt,
    versions: {
      corpus: configuration.corpusVersion,
      prompt: configuration.promptVersion,
      wireSchema: configuration.wireSchemaVersion,
    },
    pipelineLimits: { ...configuration.limits },
    budget: {
      briefs: configuration.budget.briefs,
      maxRequests: configuration.budget.maxRequests,
      maxHttpAttempts: configuration.budget.maxHttpAttempts,
    },
    checkpoint: { ...manifest.checkpoint },
    completeness: { ...manifest.completeness, reasons: [...manifest.completeness.reasons] },
    halt: manifest.halt === null ? null : { ...manifest.halt },
    observed: {
      requests: observed.requests,
      httpAttempts: observed.httpAttempts,
      totalsAreLowerBound: observed.coverage.status === 'PARTIAL',
      coverage: { ...observed.coverage },
      withinBudget: observed.withinBudget,
    },
    entries: manifest.entries.map((entry) => ({
      key: entry.key,
      scenarioId: entry.scenarioId,
      version: entry.version,
      briefHash: entry.briefHash,
      status: entry.status,
      outcome: entry.outcome,
      usage: entry.usage,
      requests: entry.requests,
      httpAttempts: entry.httpAttempts,
      repaired: entry.repaired,
      stop: entry.stop === null ? null : { kind: entry.stop.kind, reason: entry.stop.reason },
      approval: entry.approval,
      artifacts: {
        state: entry.artifacts === null ? 'NOT_RECORDED' : 'VERIFIED',
        reportFile: entry.artifacts === null ? null : entry.artifacts.reportFile,
        filesChecked: perEntryFiles.get(entry.key) ?? 0,
        routeReview:
          entry.routeReview === null
            ? 'NOT_RECORDED'
            : entry.routeReview.status === 'EXPORTED'
              ? 'FILES_PRESENT'
              : entry.routeReview.status === 'FAILED'
                ? 'EXPORT_FAILURE_RECORDED'
                : 'WRITE_FAILURE_RECORDED',
      },
    })),
    artifactChecks: { ...checks, comparisonReport: comparison },
    issues: [],
    evidenceLimits: EVIDENCE_LIMITS,
  };
  return { ok: true, inspection };
}
