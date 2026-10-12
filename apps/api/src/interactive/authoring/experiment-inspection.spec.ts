import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { setAt, type JsonObject } from '../../common/test-utils/authoring-run-fixtures';
import {
  awaitingResponseBundle,
  cloneBundle,
  completeBundle,
  providerStoppedBundle,
  recordingBundle,
  runFixture,
  FAST_LIMITS,
  FIXTURE_MODEL,
  HALTING_RUNS,
  type Bundle,
  type FixtureRun,
  type RunCapture,
} from '../../../scripts/experiment-bundles.fixture';
import {
  deriveBudget,
  summarizeObservation,
  type ExperimentManifest,
  type ManifestEntry,
} from './experiment';
import {
  INSPECTION_SCHEMA,
  MAX_REPORT_BYTES,
  inspectExperiment,
  type InspectionOutcome,
} from './experiment-inspection';
import {
  MAX_ENTRIES,
  MAX_FILES_PER_ENTRY,
  MAX_MANIFEST_BYTES,
  parseExperimentManifest,
  type InspectIssue,
} from './experiment-manifest-input';

type Manifest = ExperimentManifest;
type Entry = ManifestEntry;

let shared: string;
let bundles: {
  complete: Bundle;
  stopped: Bundle;
  awaiting: Bundle;
  recording: Bundle;
};
const ALL_RUNS: readonly FixtureRun[] = ['success', 'repaired', 'rejection', ...HALTING_RUNS];
const captures = {} as Record<FixtureRun, RunCapture>;
let tmp: string;
let counter = 0;

beforeAll(async () => {
  shared = mkdtempSync(path.join(tmpdir(), 'experiment-inspection-shared-'));
  bundles = {
    complete: await completeBundle(path.join(shared, 'complete')),
    stopped: await providerStoppedBundle(path.join(shared, 'stopped')),
    awaiting: await awaitingResponseBundle(path.join(shared, 'awaiting')),
    recording: await recordingBundle(path.join(shared, 'recording')),
  };
  for (const run of ALL_RUNS)
    captures[run] = await runFixture(path.join(shared, `run-${run}`), run);
});
afterAll(() => {
  rmSync(shared, { recursive: true, force: true });
});
beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), 'experiment-inspection-spec-'));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const copyOf = (bundle: Bundle): Bundle =>
  cloneBundle(bundle, path.join(tmp, `bundle-${counter++}`));
const readManifest = (bundle: Bundle): Manifest =>
  JSON.parse(readFileSync(bundle.manifestPath, 'utf8')) as Manifest;
const writeManifest = (bundle: Bundle, manifest: Manifest): void =>
  writeFileSync(bundle.manifestPath, JSON.stringify(manifest, null, 2));
function edit(bundle: Bundle, change: (manifest: Manifest) => void): Bundle {
  const manifest = readManifest(bundle);
  change(manifest);
  writeManifest(bundle, manifest);
  return bundle;
}
const text = (bundle: Bundle): string => readFileSync(bundle.manifestPath, 'utf8');

/** Recomputes the observed block so only the tampering under test is inconsistent. */
function reobserve(manifest: Manifest): void {
  manifest['observed'] = summarizeObservation(
    manifest['entries'],
    manifest['configuration'].budget,
    manifest['checkpoint'].state,
  );
}

function issues(outcome: { ok: boolean; issues?: InspectIssue[] }): string[] {
  expect(outcome.ok).toBe(false);
  return (outcome.issues ?? []).map((i) => i.code);
}

function inspected(outcome: InspectionOutcome) {
  if (!outcome.ok)
    throw new Error(`expected a valid inspection, got ${JSON.stringify(outcome.issues)}`);
  return outcome.inspection;
}

function digest(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else {
        out[path.relative(root, full)] =
          createHash('sha256').update(readFileSync(full)).digest('hex') +
          `:${statSync(full).mtimeMs}`;
      }
    }
  };
  walk(root);
  return out;
}

// ── Pure parsing and consistency ────────────────────────────────────────────

describe('parseExperimentManifest (pure)', () => {
  it.each([
    ['complete', () => bundles.complete],
    ['provider-stopped', () => bundles.stopped],
    ['awaiting_response', () => bundles.awaiting],
    ['recording', () => bundles.recording],
  ])('accepts a real %s checkpoint', (_name, pick) => {
    const parsed = parseExperimentManifest(text(pick()));
    expect(parsed.ok).toBe(true);
  });

  it('rejects malformed JSON and non-object roots with stable codes', () => {
    expect(issues(parseExperimentManifest('{not json'))).toEqual(['MALFORMED_JSON']);
    expect(issues(parseExperimentManifest('[]'))).toEqual(['SCHEMA_INVALID']);
    expect(issues(parseExperimentManifest('null'))).toEqual(['SCHEMA_INVALID']);
  });

  it('rejects another schema version explicitly and never reinterprets v1', () => {
    for (const schema of [
      'interactive-authoring-experiment-manifest/v1',
      'interactive-authoring-experiment-manifest/v3',
    ]) {
      const manifest = readManifest(bundles.complete);
      Object.assign(manifest, { schema });
      expect(issues(parseExperimentManifest(JSON.stringify(manifest)))).toEqual([
        'SCHEMA_UNSUPPORTED',
      ]);
    }
    const manifest = readManifest(bundles.complete);
    delete (manifest as Partial<Manifest>).schema;
    expect(issues(parseExperimentManifest(JSON.stringify(manifest)))).toEqual(['SCHEMA_INVALID']);
  });

  it('rejects unknown keys instead of ignoring them', () => {
    const manifest = readManifest(bundles.complete);
    Object.assign(manifest['entries'][0], { surprise: true });
    const outcome = parseExperimentManifest(JSON.stringify(manifest));
    expect(issues(outcome)).toEqual(['SCHEMA_INVALID']);
  });

  it('rejects duplicate entry identities', () => {
    const manifest = readManifest(bundles.complete);
    manifest['entries'][1] = { ...manifest['entries'][0] };
    const codes = issues(parseExperimentManifest(JSON.stringify(manifest)));
    expect(codes).toContain('DUPLICATE_ENTRY_IDENTITY');
  });

  it('rejects a repeated scenario identity even under a different key', () => {
    const manifest = readManifest(bundles.complete);
    manifest['entries'][1].scenarioId = manifest['entries'][0].scenarioId;
    manifest['entries'][1].version = manifest['entries'][0].version;
    expect(issues(parseExperimentManifest(JSON.stringify(manifest)))).toContain(
      'DUPLICATE_ENTRY_IDENTITY',
    );
  });

  describe('entry state', () => {
    const entryTamper: Array<[string, (e: Entry) => void, number]> = [
      [
        'awaiting_response claiming reported usage',
        (e) => ((e.usage = 'REPORTED'), (e.requests = 1), (e.httpAttempts = 0)),
        1,
      ],
      [
        'an unattempted entry reporting zero requests',
        (e) => ((e.requests = 0), (e.httpAttempts = 0)),
        2,
      ],
      ['unknown usage turned into zero counts', (e) => ((e.requests = 0), (e.httpAttempts = 0)), 1],
    ];
    it.each(entryTamper)('rejects %s', (_name, change, index) => {
      const manifest = readManifest(bundles.awaiting);
      change(manifest['entries'][index]);
      reobserve(manifest);
      const codes = issues(parseExperimentManifest(JSON.stringify(manifest)));
      expect(codes).toContain('ENTRY_STATE_ILLEGAL');
    });

    it('rejects a completed entry without usage, outcome or artifacts', () => {
      for (const change of [
        (e: Entry) => (e.usage = 'UNKNOWN'),
        (e: Entry) => (e.outcome = null),
        (e: Entry) => (e.artifacts = null),
        (e: Entry) => (e.requests = null),
        (e: Entry) => (e.stop = { kind: 'PROVIDER_STOP', reason: 'NETWORK' }),
      ]) {
        const manifest = readManifest(bundles.complete);
        change(manifest['entries'][0]);
        reobserve(manifest);
        expect(issues(parseExperimentManifest(JSON.stringify(manifest)))).toContain(
          'ENTRY_STATE_ILLEGAL',
        );
      }
    });

    it('rejects a report file that does not belong to the recorded outcome', () => {
      const manifest = readManifest(bundles.complete);
      manifest['entries'][0].artifacts!.reportFile = 'run-report.json';
      manifest['entries'][0].artifacts!.files = ['run-report.json'];
      expect(issues(parseExperimentManifest(JSON.stringify(manifest)))).toContain(
        'ENTRY_STATE_ILLEGAL',
      );
    });

    it('rejects an approval marker that disagrees with the recorded files', () => {
      const manifest = readManifest(bundles.complete);
      manifest['entries'][0].approval = null;
      expect(issues(parseExperimentManifest(JSON.stringify(manifest)))).toContain(
        'ENTRY_STATE_ILLEGAL',
      );
    });

    it('rejects a settled entry after an unresolved one', () => {
      const manifest = readManifest(bundles.complete);
      manifest['entries'][0].status = 'unattempted';
      manifest['entries'][0].usage = 'NONE';
      for (const k of [
        'outcome',
        'stop',
        'repaired',
        'requests',
        'httpAttempts',
        'artifacts',
        'routeReview',
        'approval',
      ]) {
        Object.assign(manifest['entries'][0], { [k]: null });
      }
      const codes = issues(parseExperimentManifest(JSON.stringify(manifest)));
      expect(codes).toContain('ENTRY_ORDER_ILLEGAL');
    });
  });

  describe('checkpoint, completeness and halt', () => {
    it('rejects a finished manifest that still has an unresolved entry', () => {
      const manifest = readManifest(bundles.awaiting);
      manifest['checkpoint'].state = 'FINAL';
      reobserve(manifest);
      const codes = issues(parseExperimentManifest(JSON.stringify(manifest)));
      expect(codes).toContain('ENTRY_STATE_ILLEGAL');
    });

    it('rejects an IN_PROGRESS checkpoint that claims to be complete', () => {
      const manifest = readManifest(bundles.awaiting);
      manifest['completeness'].status = 'COMPLETE';
      expect(issues(parseExperimentManifest(JSON.stringify(manifest)))).toContain(
        'CHECKPOINT_INCONSISTENT',
      );
    });

    it('rejects an IN_PROGRESS checkpoint without the IN_PROGRESS reason', () => {
      const manifest = readManifest(bundles.awaiting);
      manifest['completeness'].reasons = [];
      expect(issues(parseExperimentManifest(JSON.stringify(manifest)))).toContain(
        'CHECKPOINT_INCONSISTENT',
      );
    });

    it('rejects a FINAL manifest that claims COMPLETE while an entry was stopped', () => {
      const manifest = readManifest(bundles.stopped);
      manifest['completeness'].status = 'COMPLETE';
      manifest['completeness'].reasons = [];
      expect(issues(parseExperimentManifest(JSON.stringify(manifest)))).toContain(
        'CHECKPOINT_INCONSISTENT',
      );
    });

    it('rejects entry counts that disagree with the entries', () => {
      const manifest = readManifest(bundles.complete);
      manifest['completeness'].completed = 2;
      manifest['completeness'].unattempted = 1;
      expect(issues(parseExperimentManifest(JSON.stringify(manifest)))).toContain(
        'COMPLETENESS_MISMATCH',
      );
    });

    it('rejects a halt that names no stopped entry or the wrong cause', () => {
      const missing = readManifest(bundles.stopped);
      missing['halt'] = null;
      expect(issues(parseExperimentManifest(JSON.stringify(missing)))).toContain(
        'HALT_INCONSISTENT',
      );

      const wrong = readManifest(bundles.stopped);
      wrong['halt']!.kind = 'CANCELLED';
      expect(issues(parseExperimentManifest(JSON.stringify(wrong)))).toContain('HALT_INCONSISTENT');

      const unknown = readManifest(bundles.stopped);
      unknown['halt']!.entry = 'clock-blackout';
      expect(issues(parseExperimentManifest(JSON.stringify(unknown)))).toContain(
        'HALT_INCONSISTENT',
      );
    });

    it('rejects a configuration whose budget was not derived from its limits', () => {
      const manifest = readManifest(bundles.complete);
      manifest['configuration'].budget.maxRequests += 1;
      reobserve(manifest);
      expect(issues(parseExperimentManifest(JSON.stringify(manifest)))).toContain(
        'CONFIGURATION_INCONSISTENT',
      );
    });

    it('rejects a provider that does not match the experiment mode', () => {
      const manifest = readManifest(bundles.complete);
      manifest['configuration'].provider = 'openai';
      expect(issues(parseExperimentManifest(JSON.stringify(manifest)))).toContain(
        'CONFIGURATION_INCONSISTENT',
      );
    });
  });

  describe('observed totals', () => {
    it('rejects tampered totals', () => {
      const manifest = readManifest(bundles.complete);
      manifest['observed'].requests += 1;
      expect(issues(parseExperimentManifest(JSON.stringify(manifest)))).toContain(
        'OBSERVED_TOTALS_MISMATCH',
      );
    });

    it('rejects tampered coverage', () => {
      const manifest = readManifest(bundles.awaiting);
      manifest['observed'].coverage.unknown = 0;
      manifest['observed'].coverage.notDispatched += 1;
      expect(issues(parseExperimentManifest(JSON.stringify(manifest)))).toContain(
        'COVERAGE_MISMATCH',
      );
    });

    it('rejects a within-budget claim made while usage is unresolved', () => {
      const manifest = readManifest(bundles.awaiting);
      manifest['observed'].withinBudget = true;
      expect(issues(parseExperimentManifest(JSON.stringify(manifest)))).toContain(
        'WITHIN_BUDGET_MISMATCH',
      );
    });

    it('keeps unknown usage unknown: the lower bound is reported with PARTIAL coverage', () => {
      const parsed = parseExperimentManifest(text(bundles.awaiting));
      if (!parsed.ok) throw new Error('expected ok');
      expect(parsed.manifest.observed).toMatchObject({
        requests: 1,
        withinBudget: null,
        coverage: { status: 'PARTIAL', reported: 1, unknown: 1, notDispatched: 1 },
      });
      expect(parsed.manifest.entries[1]).toMatchObject({ usage: 'UNKNOWN', requests: null });
    });
  });

  describe('references', () => {
    const bad = [
      '/etc/passwd',
      'C:/Windows/win.ini',
      'C:\\Windows\\win.ini',
      '../outside',
      'runs/../../outside',
      'runs/./x',
      'runs//x',
      '\\\\server\\share',
      'runs\\x',
      'runs/x:stream',
      'runs/x.',
      'runs/%2e%2e',
      '',
    ];
    it.each(bad)('rejects the report directory reference %j', (reference) => {
      const manifest = readManifest(bundles.complete);
      manifest['entries'][0].artifacts!.dir = reference;
      expect(issues(parseExperimentManifest(JSON.stringify(manifest)))).toContain(
        'REFERENCE_INVALID',
      );
    });

    it('rejects file names that carry a path and a comparison report that is not the fixed one', () => {
      const manifest = readManifest(bundles.complete);
      manifest['entries'][0].artifacts!.files.push('../manifest.json');
      expect(issues(parseExperimentManifest(JSON.stringify(manifest)))).toContain(
        'REFERENCE_INVALID',
      );

      const other = readManifest(bundles.complete);
      other['comparisonReport'] = '../comparison-report.json';
      expect(issues(parseExperimentManifest(JSON.stringify(other)))).toContain('REFERENCE_INVALID');
    });

    it('rejects route-review references that are not the entry’s own pair', () => {
      const manifest = readManifest(bundles.complete);
      (manifest['entries'][0].routeReview as { files: string[] }).files = [
        'route-reviews/../../x.json',
        'route-reviews/x.md',
      ];
      expect(issues(parseExperimentManifest(JSON.stringify(manifest)))).toContain(
        'REFERENCE_INVALID',
      );
    });

    it('bounds entries and file counts', () => {
      const manyEntries = readManifest(bundles.complete);
      manyEntries['entries'] = Array.from(
        { length: MAX_ENTRIES + 1 },
        () => manyEntries['entries'][0],
      );
      expect(issues(parseExperimentManifest(JSON.stringify(manyEntries)))).toContain(
        'BOUND_EXCEEDED',
      );

      const manyFiles = readManifest(bundles.complete);
      manyFiles['entries'][0].artifacts!.files = Array.from(
        { length: MAX_FILES_PER_ENTRY + 1 },
        (_, i) => `f${i}.json`,
      );
      expect(issues(parseExperimentManifest(JSON.stringify(manyFiles)))).toContain(
        'BOUND_EXCEEDED',
      );
    });
  });

  it('uses the production budget derivation', () => {
    const parsed = parseExperimentManifest(text(bundles.complete));
    if (!parsed.ok) throw new Error('expected ok');
    expect(parsed.manifest.configuration.budget).toEqual(deriveBudget(3, FAST_LIMITS));
  });
});

// ── Halted recording checkpoints (real runner) ──────────────────────────────

describe('halted recording checkpoints (real runner)', () => {
  const HALTED: Array<[FixtureRun, string, string]> = [
    ['generation-provider-stop', 'PROVIDER_STOP', 'NETWORK'],
    ['repair-provider-stop', 'PROVIDER_STOP', 'NETWORK'],
    ['cancellation', 'CANCELLED', 'CANCELLED'],
  ];
  const frozen = (run: FixtureRun): Bundle => captures[run].haltedRecording!;
  const frozenManifest = (run: FixtureRun): Manifest => readManifest(frozen(run));
  const parse = (manifest: Manifest) => parseExperimentManifest(JSON.stringify(manifest));

  describe.each(HALTED)('%s', (run, kind, reason) => {
    it('captures the STOPPED result while its entry is still recording', () => {
      const manifest = frozenManifest(run);
      expect(manifest['checkpoint'].state).toBe('IN_PROGRESS');
      expect(manifest['entries'][1]).toMatchObject({
        key: 'harbour-ledger',
        status: 'recording',
        outcome: 'STOPPED',
        usage: 'REPORTED',
        stop: { kind, reason },
        artifacts: null,
      });
      expect(manifest['halt']).toEqual({ kind, entry: 'harbour-ledger', reason });
    });

    it('is accepted by the parser with its reported counts preserved', () => {
      const manifest = frozenManifest(run);
      const parsed = parse(manifest);
      if (!parsed.ok) throw new Error(`rejected: ${JSON.stringify(parsed.issues)}`);
      const entry = parsed.manifest.entries[1]!;
      expect(entry.requests).toBe(manifest['entries'][1].requests);
      expect(entry.httpAttempts).toBe(manifest['entries'][1].httpAttempts);
      expect(entry.requests).toBeGreaterThanOrEqual(1);
      expect(parsed.manifest.halt).toEqual(manifest['halt']);
    });

    it('is inspectable as saved state without liveness or billing claims', () => {
      const bundle = copyOf(frozen(run));
      const before = digest(bundle.dir);
      const inspection = inspected(inspectExperiment(bundle.manifestPath));
      expect(inspection.checkpoint.state).toBe('IN_PROGRESS');
      expect(inspection.completeness).toMatchObject({
        recording: 1,
        stopped: 0,
        awaitingResponse: 0,
      });
      expect(inspection.halt).toEqual({ kind, entry: 'harbour-ledger', reason });
      expect(inspection.entries[1]).toMatchObject({ status: 'recording', outcome: 'STOPPED' });
      expect(inspection.entries[1]!.artifacts!.state).toBe('NOT_RECORDED');
      expect(inspection.observed).toMatchObject({ withinBudget: null });
      expect(inspection.observed.coverage.status).toBe('PARTIAL');
      expect(JSON.stringify(inspection)).not.toMatch(
        /\bdead\b|crash|killed|terminated|is running|currently running/i,
      );
      expect(digest(bundle.dir)).toEqual(before);
    });

    it('has a corresponding final manifest whose halt references a stopped entry', () => {
      const manifest = readManifest(captures[run].final);
      expect(manifest['checkpoint'].state).toBe('FINAL');
      expect(manifest['halt']).toEqual({ kind, entry: 'harbour-ledger', reason });
      expect(manifest['entries'][1]).toMatchObject({ status: 'stopped', outcome: 'STOPPED' });
      expect(parse(manifest).ok).toBe(true);
      const inspection = inspected(inspectExperiment(copyOf(captures[run].final).manifestPath));
      expect(inspection.completeness).toMatchObject({ status: 'INCOMPLETE', stopped: 1 });
    });

    it.each([
      ['an unattempted entry', (m: Manifest) => (m['halt']!.entry = 'clock-blackout')],
      ['an earlier completed entry', (m: Manifest) => (m['halt']!.entry = 'last-tram')],
      [
        'a different kind',
        (m: Manifest) => (m['halt']!.kind = kind === 'CANCELLED' ? 'PROVIDER_STOP' : 'CANCELLED'),
      ],
      ['a different reason', (m: Manifest) => (m['halt']!.reason = 'TIMEOUT')],
      ['no halt at all', (m: Manifest) => (m['halt'] = null)],
    ])('still rejects a halt that names %s', (_name, change) => {
      const manifest = frozenManifest(run);
      change(manifest);
      expect(issues(parse(manifest))).toContain('HALT_INCONSISTENT');
    });

    it('still validates reported usage and counts on the recording entry', () => {
      for (const change of [
        (e: Entry) => (e.usage = 'UNKNOWN'),
        (e: Entry) => ((e.requests = null), (e.httpAttempts = null)),
      ]) {
        const manifest = frozenManifest(run);
        change(manifest['entries'][1]);
        reobserve(manifest);
        expect(issues(parse(manifest))).toContain('ENTRY_STATE_ILLEGAL');
      }
      const inflated = frozenManifest(run);
      inflated['entries'][1].requests! += 1;
      expect(issues(parse(inflated))).toContain('OBSERVED_TOTALS_MISMATCH');
    });

    it('rejects the same recording entry in a FINAL manifest', () => {
      const manifest = frozenManifest(run);
      manifest['checkpoint'].state = 'FINAL';
      manifest['completeness'].reasons = manifest['completeness'].reasons.filter(
        (r: string) => r !== 'IN_PROGRESS',
      );
      reobserve(manifest);
      const codes = issues(parse(manifest));
      expect(codes).toContain('ENTRY_STATE_ILLEGAL');
      expect(codes).toContain('HALT_INCONSISTENT');
    });
  });

  it.each([
    ['a successful recording entry', () => bundles.recording, 0],
    ['an awaiting_response entry', () => bundles.awaiting, 1],
    ['an unattempted entry', () => bundles.awaiting, 2],
    ['a completed entry', () => bundles.awaiting, 0],
  ])('does not let an IN_PROGRESS halt attach to %s', (_name, pick, index) => {
    const manifest = readManifest(pick());
    manifest['halt'] = {
      kind: 'PROVIDER_STOP',
      entry: manifest['entries'][index].key,
      reason: 'NETWORK',
    };
    manifest['completeness'].reasons = ['PROVIDER_STOP', 'IN_PROGRESS'];
    expect(issues(parseExperimentManifest(JSON.stringify(manifest)))).toContain(
      'HALT_INCONSISTENT',
    );
  });

  it('keeps a FINAL halt that references a non-stopped entry invalid', () => {
    const manifest = readManifest(bundles.stopped);
    manifest['halt']!.entry = 'last-tram'; // completed
    expect(issues(parseExperimentManifest(JSON.stringify(manifest)))).toContain(
      'HALT_INCONSISTENT',
    );
  });
});

describe('checkpoint compatibility (every checkpoint the real runner emits)', () => {
  it.each(ALL_RUNS)('parses every checkpoint of the %s run', (run) => {
    const { checkpoints } = captures[run];
    expect(checkpoints.length).toBeGreaterThanOrEqual(5);
    const sequences: number[] = [];
    checkpoints.forEach((raw, index) => {
      const parsed = parseExperimentManifest(raw);
      if (!parsed.ok) {
        throw new Error(
          `${run} checkpoint ${index + 1} rejected: ${JSON.stringify(parsed.issues)}`,
        );
      }
      sequences.push(parsed.manifest.checkpoint.sequence);
      expect(parsed.manifest.checkpoint.state).toBe(
        index === checkpoints.length - 1 ? 'FINAL' : 'IN_PROGRESS',
      );
    });
    expect(sequences).toEqual(sequences.map((_, i) => i + 1));
  });

  it.each(HALTING_RUNS)('emits a halted recording checkpoint in the %s run', (run) => {
    const halted = captures[run].checkpoints
      .map((raw) => JSON.parse(raw) as Manifest)
      .filter((m) => m['halt'] !== null && m['checkpoint'].state === 'IN_PROGRESS')
      .filter((m) =>
        m['entries'].some((e: Entry) => e.status === 'recording' && e.outcome === 'STOPPED'),
      );
    expect(halted.length).toBeGreaterThan(0);
  });
});

// ── Filesystem inspection ───────────────────────────────────────────────────

describe('inspectExperiment (real runner bundles)', () => {
  it('summarises a complete offline experiment', () => {
    const bundle = copyOf(bundles.complete);
    const inspection = inspected(inspectExperiment(bundle.manifestPath));
    expect(inspection.schema).toBe(INSPECTION_SCHEMA);
    expect(inspection.status).toBe('VALID');
    expect(inspection.checkpoint).toEqual({ state: 'FINAL', sequence: expect.any(Number) });
    expect(inspection.completeness).toMatchObject({
      status: 'COMPLETE',
      reasons: [],
      total: 3,
      completed: 3,
    });
    expect(inspection.entries.map((e) => [e.key, e.status, e.usage, e.requests])).toEqual([
      ['last-tram', 'completed', 'REPORTED', 1],
      ['harbour-ledger', 'completed', 'REPORTED', 1],
      ['clock-blackout', 'completed', 'REPORTED', 1],
    ]);
    expect(inspection.observed).toMatchObject({
      requests: 3,
      httpAttempts: 0,
      withinBudget: true,
      coverage: { status: 'COMPLETE', reported: 3, unknown: 0, notDispatched: 0 },
    });
    expect(inspection.artifactChecks).toMatchObject({
      entriesWithArtifacts: 3,
      runReportsCompared: 3,
      comparisonReport: 'PRESENT',
    });
    expect(inspection.entries[0]!.artifacts).toMatchObject({
      state: 'VERIFIED',
      reportFile: 'validation-report.json',
      routeReview: 'FILES_PRESENT',
    });
    expect(inspection.issues).toEqual([]);
  });

  it('summarises a provider-stopped experiment with its unattempted tail', () => {
    const inspection = inspected(inspectExperiment(copyOf(bundles.stopped).manifestPath));
    expect(inspection.completeness).toMatchObject({
      status: 'INCOMPLETE',
      completed: 1,
      stopped: 1,
      unattempted: 1,
    });
    expect(inspection.halt).toEqual({
      kind: 'PROVIDER_STOP',
      entry: 'harbour-ledger',
      reason: 'NETWORK',
    });
    expect(inspection.entries[1]).toMatchObject({
      status: 'stopped',
      outcome: 'STOPPED',
      usage: 'REPORTED',
      stop: { kind: 'PROVIDER_STOP', reason: 'NETWORK' },
    });
    expect(inspection.entries[1]!.artifacts).toMatchObject({
      state: 'VERIFIED',
      reportFile: 'run-report.json',
    });
    expect(inspection.entries[2]!.artifacts!.state).toBe('NOT_RECORDED');
    expect(inspection.model).toBe(FIXTURE_MODEL);
  });

  it('keeps an awaiting_response entry unresolved with UNKNOWN usage', () => {
    const inspection = inspected(inspectExperiment(copyOf(bundles.awaiting).manifestPath));
    expect(inspection.checkpoint.state).toBe('IN_PROGRESS');
    expect(inspection.completeness).toMatchObject({
      status: 'INCOMPLETE',
      awaitingResponse: 1,
      completed: 1,
      unattempted: 1,
    });
    expect(inspection.completeness.reasons).toContain('IN_PROGRESS');
    expect(inspection.entries[1]).toMatchObject({
      status: 'awaiting_response',
      usage: 'UNKNOWN',
      requests: null,
      httpAttempts: null,
    });
    expect(inspection.entries[1]!.artifacts!.state).toBe('NOT_RECORDED');
    expect(inspection.observed).toMatchObject({
      requests: 1,
      withinBudget: null,
      totalsAreLowerBound: true,
      coverage: { status: 'PARTIAL', reported: 1, unknown: 1, notDispatched: 1 },
    });
    expect(inspection.artifactChecks.comparisonReport).toBe('NOT_RECORDED');
  });

  it('accepts a recording entry with reported counts and no artifact references yet', () => {
    const inspection = inspected(inspectExperiment(copyOf(bundles.recording).manifestPath));
    expect(inspection.entries[0]).toMatchObject({
      status: 'recording',
      usage: 'REPORTED',
      outcome: 'REVIEW_REQUIRED',
      requests: 1,
    });
    expect(inspection.entries[0]!.artifacts!.state).toBe('NOT_RECORDED');
    expect(inspection.completeness).toMatchObject({ recording: 1, awaitingResponse: 0 });
  });

  it('describes an IN_PROGRESS checkpoint only as saved state, never as a process or a failure', () => {
    const inspection = inspected(inspectExperiment(copyOf(bundles.awaiting).manifestPath));
    const serialized = JSON.stringify(inspection);
    expect(serialized).not.toMatch(
      /\bdead\b|crash|killed|terminated|is running|currently running|failed request/i,
    );
    expect(inspection.evidenceLimits.join(' ')).toMatch(/does not (show|establish)/i);
    expect(inspection.evidenceLimits.join(' ')).toMatch(/billing/i);
    expect(inspection.evidenceLimits.join(' ')).toMatch(/approval/i);
  });

  it('does not write anything, even a timestamp', () => {
    const bundle = copyOf(bundles.complete);
    const before = digest(bundle.dir);
    const names = readdirSync(bundle.dir);
    inspectExperiment(bundle.manifestPath);
    inspectExperiment(copyOf(bundles.awaiting).manifestPath);
    expect(digest(bundle.dir)).toEqual(before);
    expect(readdirSync(bundle.dir)).toEqual(names);
  });

  it('is deterministic', () => {
    const bundle = copyOf(bundles.stopped);
    expect(JSON.stringify(inspectExperiment(bundle.manifestPath))).toBe(
      JSON.stringify(inspectExperiment(bundle.manifestPath)),
    );
  });

  it('emits an allowlisted result: no absolute path, prose or exception text', () => {
    for (const bundle of [bundles.complete, bundles.stopped, bundles.awaiting, bundles.recording]) {
      const copy = copyOf(bundle);
      const raw = JSON.stringify(inspectExperiment(copy.manifestPath));
      expect(raw).not.toContain(copy.dir);
      expect(raw).not.toContain(tmp);
      expect(raw).not.toContain(path.basename(copy.dir));
      expect(raw).not.toContain('Scripted fixture responses'); // evidence note prose
      expect(raw).not.toContain('Editorial approval:'); // notEvidenceOf prose
      expect(raw).not.toMatch(/[A-Za-z]:[\\/]/);
      expect(raw).not.toMatch(/runs[\\/]/);
      expect(raw).not.toContain('scenario-drafts');
    }
  });
});

describe('inspectExperiment (invalid input)', () => {
  it('reports an unreadable manifest', () => {
    const missing = path.join(tmp, 'nope', 'manifest.json');
    expect(issues(inspectExperiment(missing))).toEqual(['MANIFEST_UNREADABLE']);
    expect(issues(inspectExperiment(tmp))).toEqual(['MANIFEST_UNREADABLE']);
  });

  it('rejects an oversized manifest without parsing it', () => {
    const bundle = copyOf(bundles.complete);
    writeFileSync(bundle.manifestPath, ' '.repeat(MAX_MANIFEST_BYTES + 1));
    expect(issues(inspectExperiment(bundle.manifestPath))).toEqual(['MANIFEST_TOO_LARGE']);
  });

  it('rejects an unsupported schema, malformed JSON and tampered counts as failures with no summary', () => {
    const v1 = edit(copyOf(bundles.complete), (m) => {
      Object.assign(m, { schema: 'interactive-authoring-experiment-manifest/v1' });
    });
    const unsupported = inspectExperiment(v1.manifestPath);
    expect(issues(unsupported)).toEqual(['SCHEMA_UNSUPPORTED']);
    expect(unsupported).not.toHaveProperty('inspection');

    const broken = copyOf(bundles.complete);
    writeFileSync(broken.manifestPath, '{"schema":');
    expect(issues(inspectExperiment(broken.manifestPath))).toEqual(['MALFORMED_JSON']);

    const tampered = edit(copyOf(bundles.complete), (m) => {
      m['observed'].httpAttempts += 4;
    });
    expect(issues(inspectExperiment(tampered.manifestPath))).toContain('OBSERVED_TOTALS_MISMATCH');
  });

  it('rejects a manifest file that is a symbolic link', () => {
    const bundle = copyOf(bundles.complete);
    const real = path.join(bundle.dir, 'manifest.real.json');
    renameSync(bundle.manifestPath, real);
    try {
      symlinkSync(real, bundle.manifestPath, 'file');
    } catch {
      return; // symlinks unavailable on this machine
    }
    expect(issues(inspectExperiment(bundle.manifestPath))).toEqual(['MANIFEST_UNREADABLE']);
  });
});

describe('inspectExperiment (referenced artifacts)', () => {
  const firstRunDir = (bundle: Bundle): string => {
    const manifest = readManifest(bundle);
    return path.join(bundle.dir, ...String(manifest['entries'][0].artifacts!.dir).split('/'));
  };

  it('reports a missing referenced run report', () => {
    const bundle = copyOf(bundles.complete);
    rmSync(path.join(firstRunDir(bundle), 'validation-report.json'));
    const outcome = inspectExperiment(bundle.manifestPath);
    expect(outcome).toMatchObject({ ok: false });
    expect(outcome.ok === false && outcome.issues).toContainEqual({
      code: 'ARTIFACT_MISSING',
      entry: 'last-tram',
    });
  });

  it.each(['validated-candidate.json', 'review-report.md', 'approval-template.json'])(
    'reports a missing referenced %s without reading it',
    (name) => {
      const bundle = copyOf(bundles.complete);
      rmSync(path.join(firstRunDir(bundle), name));
      expect(issues(inspectExperiment(bundle.manifestPath))).toContain('ARTIFACT_MISSING');
    },
  );

  it('reports a missing route review and a missing comparison report', () => {
    const bundle = copyOf(bundles.complete);
    rmSync(path.join(bundle.dir, 'route-reviews', 'last-tram.md'));
    expect(issues(inspectExperiment(bundle.manifestPath))).toContain('ARTIFACT_MISSING');

    const other = copyOf(bundles.complete);
    rmSync(path.join(other.dir, 'comparison-report.json'));
    expect(issues(inspectExperiment(other.manifestPath))).toContain('ARTIFACT_MISSING');
  });

  it('does not read candidate or review prose', () => {
    const bundle = copyOf(bundles.complete);
    writeFileSync(path.join(firstRunDir(bundle), 'review-report.md'), '\u0000\u0001 not even text');
    writeFileSync(path.join(bundle.dir, 'route-reviews', 'last-tram.json'), 'prose, not json');
    expect(inspectExperiment(bundle.manifestPath).ok).toBe(true);
  });

  it('flags a directory where a file is referenced', () => {
    const bundle = copyOf(bundles.complete);
    const target = path.join(firstRunDir(bundle), 'review-report.md');
    rmSync(target);
    mkdirSync(target);
    expect(issues(inspectExperiment(bundle.manifestPath))).toContain('ARTIFACT_NOT_A_FILE');
  });

  it('flags an oversized run report before parsing it', () => {
    const bundle = copyOf(bundles.complete);
    writeFileSync(
      path.join(firstRunDir(bundle), 'validation-report.json'),
      ' '.repeat(MAX_REPORT_BYTES + 1),
    );
    expect(issues(inspectExperiment(bundle.manifestPath))).toContain('ARTIFACT_TOO_LARGE');
  });

  it('flags a run report that does not parse', () => {
    const bundle = copyOf(bundles.complete);
    writeFileSync(
      path.join(firstRunDir(bundle), 'validation-report.json'),
      '{"status":"REVIEW_REQUIRED"}',
    );
    const outcome = inspectExperiment(bundle.manifestPath);
    expect(issues(outcome)).toContain('RUN_REPORT_INVALID');
  });

  describe('run report versus manifest', () => {
    const patchReport = (bundle: Bundle, change: (report: JsonObject) => void) => {
      const file = path.join(firstRunDir(bundle), 'validation-report.json');
      const report = JSON.parse(readFileSync(file, 'utf8')) as JsonObject;
      change(report);
      writeFileSync(file, JSON.stringify(report, null, 2));
    };

    it('detects a different brief hash', () => {
      const bundle = copyOf(bundles.complete);
      patchReport(bundle, (r) => setAt(r, ['provenance', 'briefHash'], 'a'.repeat(64)));
      expect(issues(inspectExperiment(bundle.manifestPath))).toContain(
        'RUN_REPORT_BRIEF_HASH_MISMATCH',
      );
    });

    it('detects a different provider or model', () => {
      const bundle = copyOf(bundles.complete);
      patchReport(bundle, (r) => {
        setAt(r, ['provenance', 'provider'], 'openai');
        setAt(r, ['provenance', 'model'], 'some-model');
      });
      expect(issues(inspectExperiment(bundle.manifestPath))).toContain(
        'RUN_REPORT_PROVIDER_MISMATCH',
      );
    });

    it('detects different prompt or schema versions', () => {
      const prompt = copyOf(bundles.complete);
      patchReport(prompt, (r) => setAt(r, ['provenance', 'promptVersion'], 'other-prompt/v9'));
      expect(issues(inspectExperiment(prompt.manifestPath))).toContain(
        'RUN_REPORT_VERSION_MISMATCH',
      );
      const schema = copyOf(bundles.complete);
      patchReport(schema, (r) => setAt(r, ['provenance', 'schemaVersion'], 'other-schema/v9'));
      expect(issues(inspectExperiment(schema.manifestPath))).toContain(
        'RUN_REPORT_VERSION_MISMATCH',
      );
    });

    it('detects a different outcome', () => {
      // A self-consistent IN_PROGRESS checkpoint that records the stopped entry as
      // REJECTED; only its saved run report (STOPPED) disagrees.
      const bundle = copyOf(bundles.stopped);
      edit(bundle, (m) => {
        const e = m['entries'][1];
        e.status = 'completed';
        e.outcome = 'REJECTED';
        e.stop = null;
        m['halt'] = null;
        m['comparisonReport'] = null;
        m['checkpoint'].state = 'IN_PROGRESS';
        m['completeness'] = {
          ...m['completeness'],
          status: 'INCOMPLETE',
          reasons: ['IN_PROGRESS'],
          completed: 2,
          stopped: 0,
        };
        reobserve(m);
      });
      expect(issues(inspectExperiment(bundle.manifestPath))).toEqual([
        'RUN_REPORT_OUTCOME_MISMATCH',
      ]);
    });

    it('detects a repaired flag the report does not support', () => {
      const bundle = copyOf(bundles.complete);
      edit(bundle, (m) => {
        m['entries'][0].repaired = true;
        m['entries'][0].requests = 2;
        reobserve(m);
      });
      const codes = issues(inspectExperiment(bundle.manifestPath));
      expect(codes).toContain('RUN_REPORT_OUTCOME_MISMATCH');
    });

    it('detects a request count the report does not support', () => {
      const bundle = copyOf(bundles.complete);
      edit(bundle, (m) => {
        m['entries'][1].requests = 2;
        reobserve(m);
      });
      const outcome = inspectExperiment(bundle.manifestPath);
      expect(outcome.ok === false && outcome.issues).toContainEqual({
        code: 'RUN_REPORT_REQUEST_COUNT_MISMATCH',
        entry: 'harbour-ledger',
      });
    });

    it('detects an HTTP attempt count the report does not support', () => {
      const bundle = copyOf(bundles.stopped);
      edit(bundle, (m) => {
        m['entries'][1].httpAttempts = 5;
        reobserve(m);
      });
      expect(issues(inspectExperiment(bundle.manifestPath))).toContain(
        'RUN_REPORT_REQUEST_COUNT_MISMATCH',
      );
    });

    it('detects a stop reason the report does not support', () => {
      const bundle = copyOf(bundles.stopped);
      edit(bundle, (m) => {
        m['entries'][1].stop!.reason = 'TIMEOUT';
        m['halt']!.reason = 'TIMEOUT';
      });
      expect(issues(inspectExperiment(bundle.manifestPath))).toContain(
        'RUN_REPORT_OUTCOME_MISMATCH',
      );
    });
  });

  describe('containment', () => {
    it('rejects a directory reference that is a junction/symlink to outside the experiment', () => {
      const bundle = copyOf(bundles.complete);
      const runDir = firstRunDir(bundle);
      const outside = path.join(tmp, 'outside-copy');
      cpOutside(runDir, outside);
      rmSync(runDir, { recursive: true, force: true });
      symlinkSync(outside, runDir, 'junction');
      const codes = issues(inspectExperiment(bundle.manifestPath));
      expect(codes).toContain('ARTIFACT_ESCAPES_DIRECTORY');
    });

    it('rejects a route-review directory that is a link to outside', () => {
      const bundle = copyOf(bundles.complete);
      const reviews = path.join(bundle.dir, 'route-reviews');
      const outside = path.join(tmp, 'outside-reviews');
      cpOutside(reviews, outside);
      rmSync(reviews, { recursive: true, force: true });
      symlinkSync(outside, reviews, 'junction');
      expect(issues(inspectExperiment(bundle.manifestPath))).toContain(
        'ARTIFACT_ESCAPES_DIRECTORY',
      );
    });

    it('never follows a reference that escapes lexically (the file is not even looked up)', () => {
      const bundle = copyOf(bundles.complete);
      writeFileSync(path.join(tmp, 'secret.json'), '{"secret":"do-not-read"}');
      edit(bundle, (m) => {
        m['entries'][0].artifacts!.dir = '../secret-dir';
      });
      const outcome = inspectExperiment(bundle.manifestPath);
      expect(issues(outcome)).toContain('REFERENCE_INVALID');
      expect(JSON.stringify(outcome)).not.toContain('do-not-read');
    });
  });

  describe('references only', () => {
    it('does not discover or recover unreferenced artifacts', () => {
      const bundle = copyOf(bundles.awaiting);
      // A finished-looking run directory the checkpoint never recorded.
      const stray = path.join(bundle.dir, 'runs', 'stray--review-required');
      mkdirSync(stray, { recursive: true });
      writeFileSync(path.join(stray, 'validation-report.json'), 'not even json');
      writeFileSync(path.join(bundle.dir, 'comparison-report.json'), 'not even json');
      const inspection = inspected(inspectExperiment(bundle.manifestPath));
      expect(inspection.entries[1]!.artifacts!.state).toBe('NOT_RECORDED');
      expect(inspection.entries[1]!.status).toBe('awaiting_response');
      expect(inspection.artifactChecks.comparisonReport).toBe('NOT_RECORDED');
      expect(JSON.stringify(inspection)).not.toContain('stray');
    });

    it('treats never-recorded artifacts of awaiting_response and recording entries as valid', () => {
      for (const bundle of [bundles.awaiting, bundles.recording]) {
        const copy = copyOf(bundle);
        expect(existsSync(path.join(copy.dir, 'comparison-report.json'))).toBe(false);
        expect(inspectExperiment(copy.manifestPath).ok).toBe(true);
      }
    });
  });
});

function cpOutside(from: string, to: string): void {
  mkdirSync(to, { recursive: true });
  for (const name of readdirSync(from)) {
    writeFileSync(path.join(to, name), readFileSync(path.join(from, name)));
  }
}
