import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { stamp, writeRunArtifacts, type WritableResult, type WrittenRun } from './artifacts';
import { hashBrief, parseBrief } from './brief';
import { AUTHORING_CORPUS, AUTHORING_CORPUS_VERSION, type CorpusEntry } from './corpus';
import { MAX_HTTP_ATTEMPTS, MAX_REQUESTS, PROMPT_VERSION, WIRE_SCHEMA_VERSION } from './limits';
import { runAuthoring, type AuthoringResult, type PipelineLimits } from './pipeline';
import type { ScenarioDraftProvider } from './provider';
import { exportRouteReview, type RouteReviewBounds } from './route-review';
import { buildComparisonReport } from './run-report-aggregate';
import { parseRunReport, type ReportFileName, type RunObservation } from './run-report-input';
import { ScriptedDraftProvider } from './scripted-provider';
import { scenarioToWire } from './wire';

/**
 * Bounded authoring experiment over the fixed three-entry corpus: exactly one
 * authoring attempt per brief, sequentially, through `runAuthoring` (so at most
 * one generation plus one content repair each), with every existing guard kept:
 * no transport retries, no concurrency, no repetition, no automatic resume and
 * no replacement attempts.
 *
 * An experiment is a harness, not a verdict. Mechanical validity is not
 * approval, offline runs verify the harness and say nothing about any model, and
 * a completed experiment is not evidence of prose quality.
 */

export const EXPERIMENT_PLAN_SCHEMA = 'interactive-authoring-experiment-plan/v1';
export const EXPERIMENT_MANIFEST_SCHEMA = 'interactive-authoring-experiment-manifest/v1';

export type ExperimentMode = 'offline' | 'openai';

export const EXECUTION_POLICY = {
  sequential: true,
  repetitionsPerBrief: 1,
  maxContentRepairsPerBrief: 1,
  transportRetries: 0,
  concurrency: 1,
  automaticResume: false,
  replacementAttempts: false,
} as const;

export const NOT_EVIDENCE_OF = [
  'Editorial approval: every approval template stays PENDING and nothing here approves or publishes.',
  'Prose quality: mechanical validity only means the deterministic validation stages passed.',
  'Model quality: offline runs replay scripted fixtures; any single real run is one observation.',
] as const;

// ── Plan ────────────────────────────────────────────────────────────────────

export interface ExperimentBudget {
  briefs: number;
  perBrief: {
    maxRequests: number;
    maxHttpAttempts: number;
    /** Per-request output token cap handed to the provider times the request cap; not a usage figure. */
    maxOutputTokens: number;
    maxRuntimeMs: number;
  };
  maxRequests: number;
  maxHttpAttempts: number;
  maxOutputTokens: number;
  maxRuntimeMs: number;
  transportRetries: 0;
  concurrency: 1;
}

export function deriveBudget(briefs: number, limits: PipelineLimits): ExperimentBudget {
  const perBrief = {
    maxRequests: MAX_REQUESTS,
    maxHttpAttempts: MAX_HTTP_ATTEMPTS,
    maxOutputTokens: MAX_REQUESTS * limits.maxOutputTokens,
    maxRuntimeMs: limits.deadlineMs,
  };
  return {
    briefs,
    perBrief,
    maxRequests: briefs * perBrief.maxRequests,
    maxHttpAttempts: briefs * perBrief.maxHttpAttempts,
    maxOutputTokens: briefs * perBrief.maxOutputTokens,
    maxRuntimeMs: briefs * perBrief.maxRuntimeMs,
    transportRetries: 0,
    concurrency: 1,
  };
}

export interface ExperimentEntryIdentity {
  key: CorpusEntry['key'];
  scenarioId: string;
  version: number;
  briefHash: string;
}

function identityOf(entry: CorpusEntry): ExperimentEntryIdentity {
  const parsed = parseBrief(entry.brief);
  if (!parsed.ok) throw new Error(`corpus entry ${entry.key} has an invalid brief`);
  return {
    key: entry.key,
    scenarioId: parsed.brief.scenarioId,
    version: parsed.brief.version,
    briefHash: hashBrief(parsed.brief),
  };
}

export interface ExperimentPlan {
  schema: typeof EXPERIMENT_PLAN_SCHEMA;
  /** Always false: producing a plan runs nothing. */
  executes: false;
  versions: { corpus: string; prompt: string; wireSchema: string };
  entries: ExperimentEntryIdentity[];
  selectedModel: string | null;
  limits: PipelineLimits;
  budget: ExperimentBudget;
  executionPolicy: typeof EXECUTION_POLICY;
  modes: {
    plan: { sideEffects: 'none' };
    offline: { requires: string[]; httpRequests: 0; evidence: string };
    openai: { requires: string[]; paid: true; evidence: string };
  };
  notes: string[];
}

export function buildExperimentPlan(input: {
  limits: PipelineLimits;
  model: string | null;
  corpus?: readonly CorpusEntry[];
}): ExperimentPlan {
  const corpus = input.corpus ?? AUTHORING_CORPUS;
  return {
    schema: EXPERIMENT_PLAN_SCHEMA,
    executes: false,
    versions: {
      corpus: AUTHORING_CORPUS_VERSION,
      prompt: PROMPT_VERSION,
      wireSchema: WIRE_SCHEMA_VERSION,
    },
    entries: corpus.map(identityOf),
    selectedModel: input.model,
    limits: { ...input.limits },
    budget: deriveBudget(corpus.length, input.limits),
    executionPolicy: EXECUTION_POLICY,
    modes: {
      plan: { sideEffects: 'none' },
      offline: {
        requires: ['--mode offline'],
        httpRequests: 0,
        evidence:
          'Harness verification only: scripted fixture responses, not model performance.',
      },
      openai: {
        requires: ['--mode openai', '--allow-paid-calls', '--model', 'OPENAI_API_KEY'],
        paid: true,
        evidence:
          'Observations from one attempt per brief; not approval and not evidence of prose quality.',
      },
    },
    notes: [
      'Limits are caps, not usage: observed requests, attempts and tokens are recorded only as reported.',
      'No monetary cost is estimated and unreported provider usage is never guessed.',
      'Budgets are derived from the existing per-brief limits: one generation plus at most one content repair.',
      'All corpus scenarios remain unpublished and unapproved.',
    ],
  };
}

/** Offline fixtures: replay the corpus entry's hand-authored candidate, dispatching no HTTP. */
export function offlineProviderFor(entry: CorpusEntry): ScenarioDraftProvider {
  return new ScriptedDraftProvider([
    { candidate: JSON.stringify(scenarioToWire(entry.scenario)), httpAttempts: 0 },
  ]);
}

// ── Manifest ────────────────────────────────────────────────────────────────

export type HaltKind = 'PROVIDER_STOP' | 'CANCELLED' | 'ARTIFACT_WRITE_FAILED' | 'BRIEF_REJECTED';
export type IncompleteReason =
  | HaltKind
  | 'ROUTE_REVIEW_FAILED'
  | 'COMPARISON_UNAVAILABLE';

export interface ManifestEntry extends ExperimentEntryIdentity {
  status: 'completed' | 'stopped' | 'unattempted';
  /** Final authoring result; null when the brief was never attempted. */
  outcome: 'REVIEW_REQUIRED' | 'REJECTED' | 'STOPPED' | null;
  stop: { kind: HaltKind; reason: string | null } | null;
  repaired: boolean | null;
  requests: number | null;
  httpAttempts: number | null;
  /** Run artifacts, relative to the experiment directory with `/` separators. */
  artifacts: { dir: string; reportFile: ReportFileName; files: string[] } | null;
  routeReview:
    | { status: 'EXPORTED'; files: string[] }
    | { status: 'FAILED'; code: string }
    | { status: 'WRITE_FAILED' }
    | null;
  /** `PENDING` when an approval template exists; tooling never produces another state. */
  approval: 'PENDING' | null;
}

export interface ExperimentManifest {
  schema: typeof EXPERIMENT_MANIFEST_SCHEMA;
  mode: ExperimentMode;
  createdAt: string;
  evidence: { class: 'HARNESS_VERIFICATION_ONLY' | 'OPENAI_OBSERVATIONS_UNVERIFIED'; note: string };
  configuration: {
    corpusVersion: string;
    promptVersion: string;
    wireSchemaVersion: string;
    provider: 'scripted' | 'openai';
    model: string | null;
    limits: PipelineLimits;
    budget: ExperimentBudget;
    executionPolicy: typeof EXECUTION_POLICY;
  };
  completeness: {
    status: 'COMPLETE' | 'INCOMPLETE';
    reasons: IncompleteReason[];
    total: number;
    completed: number;
    stopped: number;
    unattempted: number;
  };
  halt: { kind: HaltKind; entry: CorpusEntry['key'] | null; reason: string | null } | null;
  observed: { requests: number; httpAttempts: number; withinBudget: boolean };
  entries: ManifestEntry[];
  comparisonReport: string | null;
  notEvidenceOf: string[];
}

export type ExperimentRunResult =
  | { ok: true; dir: string; manifest: ExperimentManifest }
  /** Nothing was dispatched: the experiment directory could not be created. */
  | { ok: false; code: 'EXPERIMENT_DIR_UNAVAILABLE' }
  /** The runs happened but the manifest could not be recorded; the work directory stays `.incomplete`. */
  | {
      ok: false;
      code: 'MANIFEST_WRITE_FAILED' | 'FINALIZE_FAILED';
      dir: string;
      manifest: ExperimentManifest;
    };

export interface RunExperimentOptions {
  mode: ExperimentMode;
  providerFor: (entry: CorpusEntry) => ScenarioDraftProvider;
  limits: PipelineLimits;
  /** Already validated by the caller (see `validateDraftsRoot`). */
  draftsRoot: string;
  model?: string | null | undefined;
  corpus?: readonly CorpusEntry[] | undefined;
  /** External cancellation (SIGINT). Checked before every dispatch. */
  signal?: AbortSignal | undefined;
  now?: Date | undefined;
  /** Pipeline clock override (tests). */
  clock?: (() => number) | undefined;
  randomHex?: (() => string) | undefined;
  routeReviewBounds?: Partial<RouteReviewBounds> | undefined;
  /** Seams for failure injection; the defaults are the real writers. */
  writeRun?: ((options: Parameters<typeof writeRunArtifacts>[0]) => WrittenRun) | undefined;
  writeText?: ((file: string, text: string) => void) | undefined;
  onEntry?: ((entry: ManifestEntry) => void) | undefined;
}

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
const posix = (p: string) => p.split(path.sep).join('/');
const exclusiveWrite = (file: string, text: string) =>
  writeFileSync(file, text, { flag: 'wx', encoding: 'utf8' });

type Halt = NonNullable<ExperimentManifest['halt']>;

function reportFileFor(result: WritableResult): ReportFileName {
  return result.status === 'REVIEW_REQUIRED' ? 'validation-report.json' : 'run-report.json';
}

export async function runExperiment(options: RunExperimentOptions): Promise<ExperimentRunResult> {
  const corpus = options.corpus ?? AUTHORING_CORPUS;
  const writeRun = options.writeRun ?? writeRunArtifacts;
  const writeText = options.writeText ?? exclusiveWrite;
  const createdAt = options.now ?? new Date();
  const hex = options.randomHex ?? (() => randomBytes(4).toString('hex'));
  const identities = corpus.map(identityOf);

  // Create the experiment directory BEFORE the first dispatch so that a paid
  // attempt can never be spent without somewhere to record it.
  const base = path.join(options.draftsRoot, `${stamp(createdAt)}-authoring-experiment-${hex()}`);
  const workDir = `${base}.incomplete`;
  const runsDir = path.join(workDir, 'runs');
  try {
    mkdirSync(options.draftsRoot, { recursive: true });
    if ([`${base}--complete`, `${base}--partial`, workDir].some((p) => existsSync(p))) {
      return { ok: false, code: 'EXPERIMENT_DIR_UNAVAILABLE' };
    }
    mkdirSync(workDir); // non-recursive: throws if it already exists
    mkdirSync(runsDir);
  } catch {
    return { ok: false, code: 'EXPERIMENT_DIR_UNAVAILABLE' };
  }

  const entries: ManifestEntry[] = [];
  const observationFiles: Array<{ file: string; name: ReportFileName }> = [];
  const reasons = new Set<IncompleteReason>();
  let halt: Halt | null = null;
  let requests = 0;
  let httpAttempts = 0;

  const pushEntry = (entry: ManifestEntry) => {
    entries.push(entry);
    options.onEntry?.(entry);
  };

  for (const [index, entry] of corpus.entries()) {
    const identity = identities[index]!;
    const unattempted: ManifestEntry = {
      ...identity,
      status: 'unattempted',
      outcome: null,
      stop: null,
      repaired: null,
      requests: null,
      httpAttempts: null,
      artifacts: null,
      routeReview: null,
      approval: null,
    };

    if (halt === null && options.signal?.aborted) {
      halt = { kind: 'CANCELLED', entry: null, reason: null };
      reasons.add('CANCELLED');
    }
    if (halt !== null) {
      pushEntry(unattempted);
      continue;
    }

    let result: AuthoringResult;
    try {
      result = await runAuthoring({
        rawBrief: entry.brief,
        provider: options.providerFor(entry),
        limits: options.limits,
        signal: options.signal,
        ...(options.clock && { now: options.clock }),
      });
    } catch {
      // runAuthoring reports every provider failure as a result; reaching this is a
      // harness defect. Treat it as a provider stop without recording the message.
      halt = { kind: 'PROVIDER_STOP', entry: entry.key, reason: 'PROVIDER_ERROR' };
      reasons.add('PROVIDER_STOP');
      pushEntry({
        ...unattempted,
        status: 'stopped',
        outcome: 'STOPPED',
        stop: { kind: 'PROVIDER_STOP', reason: 'PROVIDER_ERROR' },
      });
      continue;
    }

    if (result.status === 'BRIEF_REJECTED') {
      halt = { kind: 'BRIEF_REJECTED', entry: entry.key, reason: result.code };
      reasons.add('BRIEF_REJECTED');
      pushEntry({
        ...unattempted,
        status: 'stopped',
        stop: { kind: 'BRIEF_REJECTED', reason: result.code },
      });
      continue;
    }

    requests += result.provenance.requests.length;
    httpAttempts += result.provenance.totalHttpAttempts;
    const record: ManifestEntry = {
      ...unattempted,
      status: 'completed',
      outcome: result.status,
      repaired: result.status === 'REVIEW_REQUIRED' ? result.repaired : null,
      requests: result.provenance.requests.length,
      httpAttempts: result.provenance.totalHttpAttempts,
    };

    if (result.status === 'STOPPED') {
      const kind: HaltKind = result.reason === 'CANCELLED' ? 'CANCELLED' : 'PROVIDER_STOP';
      record.status = 'stopped';
      record.stop = { kind, reason: result.reason };
      halt = { kind, entry: entry.key, reason: result.reason };
      reasons.add(kind);
    }

    // 1. The run artifacts (candidate/reports, or the failure/stop report).
    let written: WrittenRun | null = null;
    try {
      written = writeRun({
        result,
        draftsRoot: runsDir,
        ...(options.now && { now: options.now }),
        ...(options.randomHex && { randomHex: options.randomHex }),
      });
    } catch {
      reasons.add('ARTIFACT_WRITE_FAILED');
      if (halt === null) {
        halt = { kind: 'ARTIFACT_WRITE_FAILED', entry: entry.key, reason: null };
        record.status = 'stopped';
        record.stop = { kind: 'ARTIFACT_WRITE_FAILED', reason: null };
      }
    }
    if (written) {
      const reportFile = reportFileFor(result);
      record.artifacts = {
        dir: posix(path.relative(workDir, written.dir)),
        reportFile,
        files: [...written.files],
      };
      record.approval = written.files.includes('approval-template.json') ? 'PENDING' : null;
      observationFiles.push({ file: path.join(written.dir, reportFile), name: reportFile });

      // 2. Exhaustive route review of mechanically accepted candidates only.
      if (result.status === 'REVIEW_REQUIRED') {
        const jsonExport = exportRouteReview({
          scenario: result.scenario,
          format: 'json',
          bounds: options.routeReviewBounds,
        });
        const markdown = jsonExport.ok
          ? exportRouteReview({
              scenario: result.scenario,
              format: 'markdown',
              bounds: options.routeReviewBounds,
            })
          : jsonExport;
        if (!jsonExport.ok || !markdown.ok) {
          const failure = !jsonExport.ok ? jsonExport : (markdown as { code: string });
          record.routeReview = { status: 'FAILED', code: failure.code };
          reasons.add('ROUTE_REVIEW_FAILED');
        } else {
          const files = [`route-reviews/${entry.key}.json`, `route-reviews/${entry.key}.md`];
          try {
            mkdirSync(path.join(workDir, 'route-reviews'), { recursive: true });
            writeText(path.join(workDir, files[0]!), jsonExport.text);
            writeText(path.join(workDir, files[1]!), markdown.text);
            record.routeReview = { status: 'EXPORTED', files };
          } catch {
            record.routeReview = { status: 'WRITE_FAILED' };
            reasons.add('ARTIFACT_WRITE_FAILED');
            if (halt === null) {
              halt = { kind: 'ARTIFACT_WRITE_FAILED', entry: entry.key, reason: null };
              record.status = 'stopped';
              record.stop = { kind: 'ARTIFACT_WRITE_FAILED', reason: null };
            }
          }
        }
      }
    }
    pushEntry(record);
  }

  // Comparison report: read back what actually landed on disk and reuse the
  // existing parser and aggregation, so it can only describe written artifacts.
  let comparisonReport: string | null = null;
  const observations: RunObservation[] = [];
  let unreadable = false;
  for (const { file, name } of observationFiles) {
    try {
      const parsed = parseRunReport(name, readFileSync(file, 'utf8'));
      if (parsed.ok) observations.push(parsed.observation);
      else unreadable = true;
    } catch {
      unreadable = true;
    }
  }
  if (unreadable) reasons.add('COMPARISON_UNAVAILABLE');
  else if (observations.length > 0) {
    try {
      writeText(
        path.join(workDir, 'comparison-report.json'),
        json(buildComparisonReport(observations)),
      );
      comparisonReport = 'comparison-report.json';
    } catch {
      reasons.add('ARTIFACT_WRITE_FAILED');
      reasons.add('COMPARISON_UNAVAILABLE');
    }
  }

  const count = (status: ManifestEntry['status']) => entries.filter((e) => e.status === status).length;
  const budget = deriveBudget(corpus.length, options.limits);
  const complete = reasons.size === 0 && count('completed') === entries.length;
  const manifest: ExperimentManifest = {
    schema: EXPERIMENT_MANIFEST_SCHEMA,
    mode: options.mode,
    createdAt: createdAt.toISOString(),
    evidence:
      options.mode === 'offline'
        ? {
            class: 'HARNESS_VERIFICATION_ONLY',
            note: 'Scripted fixture responses verify the harness; this is not model performance.',
          }
        : {
            class: 'OPENAI_OBSERVATIONS_UNVERIFIED',
            note: 'One attempt per brief, observed as reported; not approval and not evidence of prose quality.',
          },
    configuration: {
      corpusVersion: AUTHORING_CORPUS_VERSION,
      promptVersion: PROMPT_VERSION,
      wireSchemaVersion: WIRE_SCHEMA_VERSION,
      provider: options.mode === 'offline' ? 'scripted' : 'openai',
      model: options.mode === 'openai' ? (options.model ?? null) : null,
      limits: { ...options.limits },
      budget,
      executionPolicy: EXECUTION_POLICY,
    },
    completeness: {
      status: complete ? 'COMPLETE' : 'INCOMPLETE',
      reasons: [...reasons],
      total: entries.length,
      completed: count('completed'),
      stopped: count('stopped'),
      unattempted: count('unattempted'),
    },
    halt,
    observed: {
      requests,
      httpAttempts,
      withinBudget: requests <= budget.maxRequests && httpAttempts <= budget.maxHttpAttempts,
    },
    entries,
    comparisonReport,
    notEvidenceOf: [...NOT_EVIDENCE_OF],
  };

  try {
    writeText(path.join(workDir, 'manifest.json'), json(manifest));
  } catch {
    return { ok: false, code: 'MANIFEST_WRITE_FAILED', dir: workDir, manifest };
  }
  const finalDir = `${base}--${complete ? 'complete' : 'partial'}`;
  try {
    renameSync(workDir, finalDir);
  } catch {
    return { ok: false, code: 'FINALIZE_FAILED', dir: workDir, manifest };
  }
  return { ok: true, dir: finalDir, manifest };
}
