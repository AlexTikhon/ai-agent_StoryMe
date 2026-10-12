import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hashBrief, parseBrief } from './brief';
import { AUTHORING_CORPUS, AUTHORING_CORPUS_VERSION, type CorpusEntry } from './corpus';
import { defaultReplaceOps, replaceFileAtomically } from './atomic-replace';
import {
  buildExperimentPlan,
  EXPERIMENT_MANIFEST_SCHEMA,
  EXPERIMENT_PLAN_SCHEMA,
  offlineProviderFor,
  runExperiment,
  summarizeObservation,
  type ManifestEntry,
  type RunExperimentOptions,
} from './experiment';
import { MAX_HTTP_ATTEMPTS, MAX_REQUESTS, PROMPT_VERSION, WIRE_SCHEMA_VERSION } from './limits';
import type { PipelineLimits } from './pipeline';
import { writeRunArtifacts } from './artifacts';
import { DraftProviderError, type ScenarioDraftProvider } from './provider';
import { ScriptedDraftProvider, type ScriptStep } from './scripted-provider';
import { scenarioToWire } from './wire';

const FAST: PipelineLimits = { maxOutputTokens: 4000, requestTimeoutMs: 20, deadlineMs: 5000 };
const SECRET = 'sk-experiment-spec-secret-0123456789';

const [TRAM, HARBOUR, CLOCK] = AUTHORING_CORPUS as [CorpusEntry, CorpusEntry, CorpusEntry];

const valid = (entry: CorpusEntry): string => JSON.stringify(scenarioToWire(entry.scenario));
/** The accepted candidate with its first choice pointing at a scene that does not exist. */
const invalid = (entry: CorpusEntry): string => {
  const wire = structuredClone(scenarioToWire(entry.scenario));
  wire.scenes.flatMap((s) => s.choices)[0]!.to = 's-missing';
  return JSON.stringify(wire);
};

let tmp: string;
let draftsRoot: string;
let counter = 0;

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), 'authoring-experiment-spec-'));
  draftsRoot = path.join(tmp, 'scenario-drafts');
  counter = 0;
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  vi.restoreAllMocks();
});

type Scripts = Partial<Record<CorpusEntry['key'], ScriptStep[]>>;

/** One scripted provider per corpus entry, so dispatch order and counts are observable. */
function scripted(scripts: Scripts) {
  const providers = new Map<CorpusEntry['key'], ScriptedDraftProvider>();
  for (const entry of AUTHORING_CORPUS) {
    providers.set(entry.key, new ScriptedDraftProvider(scripts[entry.key] ?? []));
  }
  return {
    providers,
    providerFor: (entry: CorpusEntry): ScenarioDraftProvider => providers.get(entry.key)!,
    dispatched: (key: CorpusEntry['key']) => providers.get(key)!.requests.length,
  };
}

const allValid = (): Scripts => ({
  'last-tram': [{ candidate: valid(TRAM) }],
  'harbour-ledger': [{ candidate: valid(HARBOUR) }],
  'clock-blackout': [{ candidate: valid(CLOCK) }],
});

function run(options: Partial<RunExperimentOptions> & Pick<RunExperimentOptions, 'providerFor'>) {
  return runExperiment({
    mode: 'offline',
    limits: FAST,
    draftsRoot,
    now: new Date(Date.UTC(2026, 9, 12, 10, 0, 0)),
    randomHex: () => (counter++).toString(16).padStart(8, '0'),
    ...options,
  });
}

async function runOk(options: Parameters<typeof run>[0]) {
  const result = await run(options);
  if (!result.ok) throw new Error(`experiment did not finish: ${result.code}`);
  return result;
}

const readJson = (dir: string, rel: string) =>
  JSON.parse(readFileSync(path.join(dir, rel), 'utf8')) as Record<string, any>;

function digest(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const name of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, name.name);
      if (name.isDirectory()) walk(full);
      else
        out[path.relative(root, full)] = createHash('sha256')
          .update(readFileSync(full))
          .digest('hex');
    }
  };
  if (existsSync(root)) walk(root);
  return out;
}

// ── Plan ────────────────────────────────────────────────────────────────────

describe('buildExperimentPlan', () => {
  it('identifies corpus, prompt, schema and brief hashes and derives budgets from existing limits', () => {
    const plan = buildExperimentPlan({ limits: FAST, model: 'model-x' });
    expect(plan.schema).toBe(EXPERIMENT_PLAN_SCHEMA);
    expect(plan.executes).toBe(false);
    expect(plan.versions).toEqual({
      corpus: AUTHORING_CORPUS_VERSION,
      prompt: PROMPT_VERSION,
      wireSchema: WIRE_SCHEMA_VERSION,
    });
    expect(plan.selectedModel).toBe('model-x');
    expect(plan.entries.map((e) => e.key)).toEqual(AUTHORING_CORPUS.map((e) => e.key));
    for (const [i, entry] of AUTHORING_CORPUS.entries()) {
      const parsed = parseBrief(entry.brief);
      expect(parsed.ok && plan.entries[i]!.briefHash).toBe(hashBrief((parsed as any).brief));
      expect(plan.entries[i]!.briefHash).toBe(entry.expect.briefHash);
    }
    expect(plan.budget).toEqual({
      briefs: 3,
      perBrief: {
        maxRequests: MAX_REQUESTS,
        maxHttpAttempts: MAX_HTTP_ATTEMPTS,
        maxOutputTokens: MAX_REQUESTS * FAST.maxOutputTokens,
        maxRuntimeMs: FAST.deadlineMs,
      },
      maxRequests: 3 * MAX_REQUESTS,
      maxHttpAttempts: 3 * MAX_HTTP_ATTEMPTS,
      maxOutputTokens: 3 * MAX_REQUESTS * FAST.maxOutputTokens,
      maxRuntimeMs: 3 * FAST.deadlineMs,
      transportRetries: 0,
      concurrency: 1,
    });
    expect(plan.budget.maxRequests).toBe(6);
    expect(plan.budget.maxHttpAttempts).toBe(6);
  });

  it('names no money estimate and no usage it cannot know', () => {
    const plan = buildExperimentPlan({ limits: FAST, model: null });
    const keys: string[] = [];
    JSON.stringify(plan, (key, value: unknown) => {
      keys.push(key);
      return value;
    });
    expect(keys.filter((k) => /cost|price|usd|dollar|token(s)?Used|usage/i.test(k))).toEqual([]);
    expect(JSON.stringify(plan)).not.toMatch(/\$\s?\d|\bUSD\b/);
    expect(plan.selectedModel).toBeNull();
  });

  it('is deterministic and JSON-serialisable', () => {
    const a = JSON.stringify(buildExperimentPlan({ limits: FAST, model: null }));
    const b = JSON.stringify(buildExperimentPlan({ limits: FAST, model: null }));
    expect(a).toBe(b);
  });

  it('states what each execution mode needs and labels offline as harness verification', () => {
    const plan = buildExperimentPlan({ limits: FAST, model: null });
    expect(plan.modes.offline.evidence).toMatch(/harness verification/i);
    expect(plan.modes.offline.evidence).toMatch(/not model performance/i);
    expect(plan.modes.openai.requires).toEqual(
      expect.arrayContaining(['--mode openai', '--allow-paid-calls', '--model', 'OPENAI_API_KEY']),
    );
  });
});

// ── Offline execution ───────────────────────────────────────────────────────

describe('runExperiment (offline)', () => {
  it('runs all three corpus briefs sequentially, once each, with the offline fixtures', async () => {
    const order: string[] = [];
    const result = await runOk({
      providerFor: (entry) => {
        order.push(entry.key);
        return offlineProviderFor(entry);
      },
    });
    expect(order).toEqual(['last-tram', 'harbour-ledger', 'clock-blackout']);
    const m = result.manifest;
    expect(m.schema).toBe(EXPERIMENT_MANIFEST_SCHEMA);
    expect(m.completeness).toMatchObject({
      status: 'COMPLETE',
      reasons: [],
      total: 3,
      completed: 3,
      stopped: 0,
      unattempted: 0,
    });
    expect(m.entries.map((e) => [e.key, e.status, e.outcome])).toEqual([
      ['last-tram', 'completed', 'REVIEW_REQUIRED'],
      ['harbour-ledger', 'completed', 'REVIEW_REQUIRED'],
      ['clock-blackout', 'completed', 'REVIEW_REQUIRED'],
    ]);
    // Offline fixtures dispatch no HTTP request at all, and say so.
    expect(m.observed).toMatchObject({ requests: 3, httpAttempts: 0, withinBudget: true });
    expect(m.configuration.provider).toBe('scripted');
    expect(m.configuration.model).toBeNull();
    expect(m.evidence.class).toBe('HARNESS_VERIFICATION_ONLY');
    expect(m.evidence.note).toMatch(/not model performance/i);
  });

  it('finalises a fresh, status-named directory inside the drafts root and keeps approvals pending', async () => {
    const { dir, manifest } = await runOk({ providerFor: offlineProviderFor });
    expect(path.dirname(dir)).toBe(draftsRoot);
    expect(path.basename(dir)).toMatch(/--complete$/);
    expect(readdirSync(draftsRoot).filter((n) => n.endsWith('.incomplete'))).toEqual([]);

    expect(readJson(dir, 'manifest.json')).toEqual(JSON.parse(JSON.stringify(manifest)));
    for (const entry of manifest.entries) {
      expect(entry.artifacts).not.toBeNull();
      const artifacts = entry.artifacts!;
      expect(artifacts.dir).not.toMatch(/^[\\/]|\.\./);
      expect(artifacts.dir).not.toContain('\\');
      expect(artifacts.files).toEqual(
        expect.arrayContaining([
          'validated-candidate.json',
          'validation-report.json',
          'review-report.md',
          'approval-template.json',
        ]),
      );
      const approval = readJson(dir, `${artifacts.dir}/approval-template.json`);
      expect(approval['decision']).toBe('pending');
      expect(entry.approval).toBe('PENDING');
      expect(entry.routeReview).toMatchObject({ status: 'EXPORTED' });
      for (const file of (entry.routeReview as { files: string[] }).files) {
        expect(existsSync(path.join(dir, file))).toBe(true);
      }
    }
  });

  it('exports the exhaustive route review of every mechanically accepted candidate', async () => {
    const { dir, manifest } = await runOk({ providerFor: offlineProviderFor });
    for (const entry of manifest.entries) {
      const json = readJson(dir, `route-reviews/${entry.key}.json`);
      expect(json['schemaVersion']).toBe('interactive-route-review/v1');
      expect(json['exhaustive']).toBe(true);
      expect(json['routes'].length).toBe(
        AUTHORING_CORPUS.find((c) => c.key === entry.key)!.expect.routes.length,
      );
      expect(readFileSync(path.join(dir, `route-reviews/${entry.key}.md`), 'utf8').length).toBeGreaterThan(0);
    }
  });

  it('writes a comparison report from the written reports that agrees with the manifest', async () => {
    const { dir, manifest } = await runOk({ providerFor: offlineProviderFor });
    expect(manifest.comparisonReport).toBe('comparison-report.json');
    const report = readJson(dir, 'comparison-report.json');
    expect(report['schema']).toBe('interactive-authoring-run-comparison/v1');
    expect(report['inputs']).toEqual({ reports: 3, groups: 3 });
    const groups = report['groups'] as Array<Record<string, any>>;
    expect(groups.every((g) => g['evidenceClass'] === 'OFFLINE_SCRIPTED')).toBe(true);
    expect(groups.reduce((n, g) => n + g['providerRequests'], 0)).toBe(manifest.observed.requests);
    expect(groups.reduce((n, g) => n + g['httpAttempts'], 0)).toBe(manifest.observed.httpAttempts);
    expect(groups.reduce((n, g) => n + g['outcomes'].reviewRequired, 0)).toBe(
      manifest.entries.filter((e) => e.outcome === 'REVIEW_REQUIRED').length,
    );
    expect(groups.map((g) => g['key'].briefHash).sort()).toEqual(
      manifest.entries.map((e) => e.briefHash).sort(),
    );
  });

  it('never overwrites an earlier experiment: each run gets a fresh directory', async () => {
    const first = await runOk({ providerFor: offlineProviderFor });
    const before = digest(first.dir);
    const second = await runOk({ providerFor: offlineProviderFor });
    expect(second.dir).not.toBe(first.dir);
    expect(digest(first.dir)).toEqual(before);
  });

  it('refuses before any dispatch when the experiment directory already exists', async () => {
    const fixed = { randomHex: () => 'deadbeef' };
    await runOk({ providerFor: offlineProviderFor, ...fixed });
    const before = digest(draftsRoot);
    const s = scripted(allValid());
    const result = await run({ providerFor: s.providerFor, ...fixed });
    expect(result).toEqual({ ok: false, code: 'EXPERIMENT_DIR_UNAVAILABLE' });
    expect([...s.providers.values()].every((p) => p.requests.length === 0)).toBe(true);
    expect(digest(draftsRoot)).toEqual(before);
  });
});

// ── Budget, rejection and content repair ────────────────────────────────────

describe('runExperiment (budget and content outcomes)', () => {
  it('keeps content repair within six HTTP attempts across the whole suite', async () => {
    const s = scripted({
      'last-tram': [{ candidate: invalid(TRAM) }, { candidate: valid(TRAM) }],
      'harbour-ledger': [{ candidate: invalid(HARBOUR) }, { candidate: valid(HARBOUR) }],
      'clock-blackout': [{ candidate: invalid(CLOCK) }, { candidate: valid(CLOCK) }],
    });
    const { manifest } = await runOk({ providerFor: s.providerFor });
    expect(manifest.entries.map((e) => [e.outcome, e.repaired, e.requests, e.httpAttempts])).toEqual([
      ['REVIEW_REQUIRED', true, 2, 2],
      ['REVIEW_REQUIRED', true, 2, 2],
      ['REVIEW_REQUIRED', true, 2, 2],
    ]);
    expect(manifest.observed).toMatchObject({ requests: 6, httpAttempts: 6, withinBudget: true });
    expect(manifest.observed.httpAttempts).toBeLessThanOrEqual(manifest.configuration.budget.maxHttpAttempts);
    for (const key of ['last-tram', 'harbour-ledger', 'clock-blackout'] as const) {
      expect(s.dispatched(key)).toBe(2);
    }
  });

  it('observes every brief after a content REJECTED result and never starts a third request', async () => {
    const s = scripted({
      'last-tram': [{ candidate: invalid(TRAM) }, { candidate: invalid(TRAM) }, { candidate: valid(TRAM) }],
      'harbour-ledger': [{ candidate: valid(HARBOUR) }],
      'clock-blackout': [{ candidate: valid(CLOCK) }],
    });
    const { manifest, dir } = await runOk({ providerFor: s.providerFor });
    expect(manifest.entries.map((e) => e.outcome)).toEqual([
      'REJECTED',
      'REVIEW_REQUIRED',
      'REVIEW_REQUIRED',
    ]);
    expect(s.dispatched('last-tram')).toBe(2);
    expect(s.dispatched('harbour-ledger')).toBe(1);
    expect(s.dispatched('clock-blackout')).toBe(1);
    // A content rejection is an observation, not an unfinished experiment.
    expect(manifest.completeness.status).toBe('COMPLETE');
    expect(manifest.entries[0]!.status).toBe('completed');
    expect(manifest.entries[0]!.artifacts!.files).toEqual(['run-report.json']);
    expect(manifest.entries[0]!.routeReview).toBeNull();
    expect(manifest.entries[0]!.approval).toBeNull();
    expect(existsSync(path.join(dir, 'route-reviews', 'last-tram.json'))).toBe(false);
    expect(path.basename(dir)).toMatch(/--complete$/);
  });

  it('does not require generated candidates to match fixture hashes or routes', async () => {
    const varied = (entry: CorpusEntry): string => {
      const wire = structuredClone(scenarioToWire(entry.scenario));
      wire.title = `${wire.title} (a different draft)`;
      return JSON.stringify(wire);
    };
    const s = scripted({
      'last-tram': [{ candidate: varied(TRAM) }],
      'harbour-ledger': [{ candidate: varied(HARBOUR) }],
      'clock-blackout': [{ candidate: varied(CLOCK) }],
    });
    const { manifest, dir } = await runOk({ providerFor: s.providerFor, mode: 'openai' });
    expect(manifest.entries.map((e) => e.outcome)).toEqual([
      'REVIEW_REQUIRED',
      'REVIEW_REQUIRED',
      'REVIEW_REQUIRED',
    ]);
    expect(manifest.completeness.status).toBe('COMPLETE');
    for (const entry of manifest.entries) {
      const report = readJson(dir, `${entry.artifacts!.dir}/validation-report.json`);
      const fixture = AUTHORING_CORPUS.find((c) => c.key === entry.key)!;
      expect(report['candidate']['hash']).not.toBe(fixture.expect.candidateHash);
      expect(manifest.completeness.reasons).toEqual([]);
    }
  });
});

// ── Stops, cancellation and artifact failures ───────────────────────────────

describe('runExperiment (stops)', () => {
  it('stops before the next brief after a provider failure and marks the rest unattempted', async () => {
    const s = scripted({
      'last-tram': [{ candidate: valid(TRAM) }],
      'harbour-ledger': [{ fail: 'network' }],
      'clock-blackout': [{ candidate: valid(CLOCK) }],
    });
    const result = await runOk({ providerFor: s.providerFor, mode: 'openai' });
    const { manifest, dir } = result;
    expect(s.dispatched('clock-blackout')).toBe(0);
    expect(manifest.entries.map((e) => [e.key, e.status])).toEqual([
      ['last-tram', 'completed'],
      ['harbour-ledger', 'stopped'],
      ['clock-blackout', 'unattempted'],
    ]);
    expect(manifest.entries[1]).toMatchObject({
      outcome: 'STOPPED',
      stop: { kind: 'PROVIDER_STOP', reason: 'NETWORK' },
    });
    expect(manifest.entries[2]).toMatchObject({
      outcome: null,
      artifacts: null,
      requests: null,
      httpAttempts: null,
    });
    expect(manifest.halt).toEqual({ kind: 'PROVIDER_STOP', entry: 'harbour-ledger', reason: 'NETWORK' });
    expect(manifest.completeness).toMatchObject({
      status: 'INCOMPLETE',
      completed: 1,
      stopped: 1,
      unattempted: 1,
    });
    expect(manifest.completeness.reasons).toContain('PROVIDER_STOP');
    expect(path.basename(dir)).toMatch(/--partial$/);
    // Completed work and the stop report itself are preserved and compared.
    expect(manifest.entries[0]!.artifacts).not.toBeNull();
    expect(manifest.entries[1]!.artifacts!.files).toEqual(['run-report.json']);
    const report = readJson(dir, 'comparison-report.json');
    expect(report['inputs'].reports).toBe(2);
    expect(manifest.observed.requests).toBe(2);
  });

  it.each(['refusal', 'truncated', 'authentication', 'rate_limit', 'timeout', 'provider_error'] as const)(
    'treats a %s stop as a stop, not as a content rejection',
    async (fail) => {
      const s = scripted({ 'last-tram': [{ fail }] });
      const { manifest } = await runOk({ providerFor: s.providerFor });
      expect(manifest.entries.map((e) => e.status)).toEqual(['stopped', 'unattempted', 'unattempted']);
      expect(s.dispatched('harbour-ledger')).toBe(0);
      expect(s.dispatched('last-tram')).toBe(1);
    },
  );

  it('stops on cancellation mid-brief and starts nothing afterwards', async () => {
    const controller = new AbortController();
    const s = scripted({
      'last-tram': [{ candidate: valid(TRAM) }],
      'harbour-ledger': [{ hang: true }],
      'clock-blackout': [{ candidate: valid(CLOCK) }],
    });
    const pending = run({ providerFor: s.providerFor, signal: controller.signal });
    await vi.waitFor(() => expect(s.dispatched('harbour-ledger')).toBe(1));
    controller.abort();
    const result = await pending;
    if (!result.ok) throw new Error('expected a manifest');
    expect(result.manifest.entries.map((e) => e.status)).toEqual(['completed', 'stopped', 'unattempted']);
    expect(result.manifest.halt).toMatchObject({ kind: 'CANCELLED', entry: 'harbour-ledger' });
    expect(result.manifest.completeness.reasons).toContain('CANCELLED');
    expect(s.dispatched('clock-blackout')).toBe(0);
  });

  it('does not let a late completion start another brief', async () => {
    const controller = new AbortController();
    let release: () => void = () => undefined;
    let started = false;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const late: ScenarioDraftProvider = {
      name: 'scripted',
      model: null,
      draft: async () => {
        started = true;
        await gate; // ignores the signal and answers after the abort
        return { candidate: valid(HARBOUR), usage: {}, httpAttempts: 1 };
      },
    };
    const s = scripted({
      'last-tram': [{ candidate: valid(TRAM) }],
      'clock-blackout': [{ candidate: valid(CLOCK) }],
    });
    const pending = run({
      signal: controller.signal,
      providerFor: (entry) => (entry.key === 'harbour-ledger' ? late : s.providerFor(entry)),
    });
    await vi.waitFor(() => expect(started).toBe(true));
    controller.abort();
    release();
    const result = await pending;
    if (!result.ok) throw new Error('expected a manifest');
    expect(result.manifest.entries.map((e) => e.status)).toEqual(['completed', 'stopped', 'unattempted']);
    expect(s.dispatched('clock-blackout')).toBe(0);
  });

  it('does not dispatch anything when cancelled before the first brief', async () => {
    const controller = new AbortController();
    controller.abort();
    const s = scripted(allValid());
    const { manifest, dir } = await runOk({ providerFor: s.providerFor, signal: controller.signal });
    expect(manifest.entries.every((e) => e.status === 'unattempted')).toBe(true);
    expect(manifest.halt).toMatchObject({ kind: 'CANCELLED', entry: null });
    expect(manifest.completeness.status).toBe('INCOMPLETE');
    expect(manifest.comparisonReport).toBeNull();
    expect([...s.providers.values()].every((p) => p.requests.length === 0)).toBe(true);
    expect(path.basename(dir)).toMatch(/--partial$/);
  });

  it('checks for cancellation again after artifact writing, before the next dispatch', async () => {
    const controller = new AbortController();
    const s = scripted(allValid());
    let writes = 0;
    const { manifest } = await runOk({
      providerFor: s.providerFor,
      signal: controller.signal,
      writeRun: (options) => {
        const written = writeRunArtifacts(options);
        writes += 1;
        if (writes === 1) controller.abort();
        return written;
      },
    });
    expect(manifest.entries.map((e) => e.status)).toEqual(['completed', 'unattempted', 'unattempted']);
    expect(manifest.halt).toMatchObject({ kind: 'CANCELLED' });
    expect(s.dispatched('harbour-ledger')).toBe(0);
  });

  it('stops after an artifact-write failure and preserves completed artifacts', async () => {
    const s = scripted(allValid());
    let writes = 0;
    const { manifest, dir } = await runOk({
      providerFor: s.providerFor,
      writeRun: (options) => {
        writes += 1;
        if (writes === 2) throw new Error(`disk exploded for ${SECRET}`);
        return writeRunArtifacts(options);
      },
    });
    expect(manifest.entries.map((e) => e.status)).toEqual(['completed', 'stopped', 'unattempted']);
    expect(manifest.entries[1]).toMatchObject({
      outcome: 'REVIEW_REQUIRED',
      stop: { kind: 'ARTIFACT_WRITE_FAILED' },
      artifacts: null,
      requests: 1,
    });
    expect(manifest.halt).toMatchObject({ kind: 'ARTIFACT_WRITE_FAILED', entry: 'harbour-ledger' });
    expect(manifest.completeness.reasons).toContain('ARTIFACT_WRITE_FAILED');
    expect(s.dispatched('clock-blackout')).toBe(0);
    expect(existsSync(path.join(dir, manifest.entries[0]!.artifacts!.dir, 'validation-report.json'))).toBe(true);
    expect(readFileSync(path.join(dir, 'manifest.json'), 'utf8')).not.toContain(SECRET);
    expect(path.basename(dir)).toMatch(/--partial$/);
  });

  it('stops when a route-review file cannot be written', async () => {
    const s = scripted(allValid());
    const { manifest } = await runOk({
      providerFor: s.providerFor,
      writeText: (file, text) => {
        if (file.includes('harbour-ledger') && file.includes('route-reviews')) throw new Error('nope');
        writeFileSync(file, text, { flag: 'wx' });
      },
    });
    expect(manifest.entries.map((e) => e.status)).toEqual(['completed', 'stopped', 'unattempted']);
    expect(manifest.entries[1]!.stop).toMatchObject({ kind: 'ARTIFACT_WRITE_FAILED' });
    // The run artifacts that did land are still referenced.
    expect(manifest.entries[1]!.artifacts).not.toBeNull();
    expect(s.dispatched('clock-blackout')).toBe(0);
  });

  it('records a route-review bound failure without stopping the experiment', async () => {
    const s = scripted(allValid());
    const { manifest } = await runOk({
      providerFor: s.providerFor,
      routeReviewBounds: { maxRoutes: 1 },
    });
    expect(manifest.entries.map((e) => e.status)).toEqual(['completed', 'completed', 'completed']);
    expect(manifest.entries.some((e) => (e.routeReview as any)?.status === 'FAILED')).toBe(true);
    expect(manifest.completeness.status).toBe('INCOMPLETE');
    expect(manifest.completeness.reasons).toContain('ROUTE_REVIEW_FAILED');
    expect(manifest.halt).toBeNull();
    expect(s.dispatched('clock-blackout')).toBe(1);
  });

  it('leaves the work directory incomplete and says so when the manifest cannot be written', async () => {
    const s = scripted(allValid());
    const result = await run({
      providerFor: s.providerFor,
      writeManifest: (file, text) => {
        if (text.includes('"state": "FINAL"')) throw new Error('disk full');
        replaceFileAtomically(file, text);
      },
    });
    expect(result).toMatchObject({ ok: false, code: 'MANIFEST_WRITE_FAILED' });
    const names = readdirSync(draftsRoot);
    expect(names).toHaveLength(1);
    expect(names[0]).toMatch(/\.incomplete$/);
    // The last good checkpoint is still there, parseable and explicitly in progress.
    const checkpoint = readJson(path.join(draftsRoot, names[0]!), 'manifest.json');
    expect(checkpoint['checkpoint'].state).toBe('IN_PROGRESS');
  });
});

// ── Progress checkpoints ────────────────────────────────────────────────────

type Snapshot = Record<string, any>;

/** Records every manifest write in order (and every dispatch), persisting it for real. */
function checkpointLog(options: { failAt?: (call: number, snapshot: Snapshot) => boolean } = {}) {
  const snapshots: Snapshot[] = [];
  const events: string[] = [];
  let calls = 0;
  return {
    snapshots,
    events,
    get calls() {
      return calls;
    },
    writeManifest: (file: string, text: string) => {
      calls += 1;
      const snapshot = JSON.parse(text) as Snapshot;
      if (options.failAt?.(calls, snapshot)) {
        events.push(`checkpoint-failed:${calls}`);
        throw new Error('checkpoint refused');
      }
      replaceFileAtomically(file, text);
      snapshots.push(snapshot);
      events.push(
        `checkpoint[${snapshot['checkpoint'].state}]:${(snapshot['entries'] as ManifestEntry[])
          .map((e) => e.status)
          .join('/')}`,
      );
    },
    /** Wraps a provider factory so each dispatch lands in the same ordered log. */
    observing:
      (providerFor: (entry: CorpusEntry) => ScenarioDraftProvider) =>
      (entry: CorpusEntry): ScenarioDraftProvider => {
        const inner = providerFor(entry);
        return {
          name: inner.name,
          model: inner.model,
          draft: (request) => {
            events.push(`dispatch:${entry.key}`);
            return inner.draft(request);
          },
        };
      },
  };
}

const onDiskCheckpoint = (): Snapshot => {
  const dir = readdirSync(draftsRoot).find((n) => n.endsWith('.incomplete'));
  if (!dir) throw new Error('no work directory');
  return readJson(path.join(draftsRoot, dir), 'manifest.json');
};

describe('runExperiment (progress checkpoints)', () => {
  it('persists a checkpoint before, between and after every dispatch, in order', async () => {
    const s = scripted(allValid());
    const log = checkpointLog();
    await runOk({ providerFor: log.observing(s.providerFor), writeManifest: log.writeManifest });
    expect(log.events).toEqual([
      'checkpoint[IN_PROGRESS]:unattempted/unattempted/unattempted',
      'checkpoint[IN_PROGRESS]:awaiting_response/unattempted/unattempted',
      'dispatch:last-tram',
      'checkpoint[IN_PROGRESS]:recording/unattempted/unattempted',
      'checkpoint[IN_PROGRESS]:completed/unattempted/unattempted',
      'checkpoint[IN_PROGRESS]:completed/awaiting_response/unattempted',
      'dispatch:harbour-ledger',
      'checkpoint[IN_PROGRESS]:completed/recording/unattempted',
      'checkpoint[IN_PROGRESS]:completed/completed/unattempted',
      'checkpoint[IN_PROGRESS]:completed/completed/awaiting_response',
      'dispatch:clock-blackout',
      'checkpoint[IN_PROGRESS]:completed/completed/recording',
      'checkpoint[IN_PROGRESS]:completed/completed/completed',
      'checkpoint[FINAL]:completed/completed/completed',
    ]);
  });

  it('has the entry identity and an in-flight status on disk when the provider is called', async () => {
    const s = scripted(allValid());
    const seen: Snapshot[] = [];
    await runOk({
      providerFor: (entry) => {
        const inner = s.providerFor(entry);
        return {
          name: inner.name,
          model: inner.model,
          draft: (request) => {
            if (entry.key === 'last-tram') seen.push(onDiskCheckpoint());
            return inner.draft(request);
          },
        };
      },
    });
    expect(seen).toHaveLength(1);
    const m = seen[0]!;
    expect(m['schema']).toBe('interactive-authoring-experiment-manifest/v2');
    expect(m['checkpoint']).toMatchObject({ state: 'IN_PROGRESS' });
    expect(m['completeness']).toMatchObject({
      status: 'INCOMPLETE',
      total: 3,
      completed: 0,
      stopped: 0,
      awaitingResponse: 1,
      recording: 0,
      unattempted: 2,
    });
    expect(m['completeness'].reasons).toContain('IN_PROGRESS');
    expect(m['entries'].map((e: ManifestEntry) => e.status)).toEqual([
      'awaiting_response',
      'unattempted',
      'unattempted',
    ]);
    expect(m['entries'][0]).toMatchObject({
      key: 'last-tram',
      briefHash: TRAM.expect.briefHash,
      outcome: null,
      requests: null,
      httpAttempts: null,
      artifacts: null,
      usage: 'UNKNOWN',
    });
    expect(m['entries'][1]).toMatchObject({ usage: 'NONE', requests: null });
    expect(m['comparisonReport']).toBeNull();
    expect(m['halt']).toBeNull();
  });

  it('never claims "within budget" while an entry is unresolved', async () => {
    const s = scripted(allValid());
    const log = checkpointLog();
    await runOk({ providerFor: log.observing(s.providerFor), writeManifest: log.writeManifest });
    const intermediate = log.snapshots.filter((x) => x['checkpoint'].state === 'IN_PROGRESS');
    expect(intermediate.length).toBeGreaterThan(0);
    for (const snapshot of intermediate) {
      expect(snapshot['observed'].withinBudget).toBeNull();
      expect(snapshot['observed'].coverage.status).toBe('PARTIAL');
    }
    const awaiting = intermediate.find((x) =>
      x['entries'].some((e: ManifestEntry) => e.status === 'awaiting_response'),
    )!;
    expect(awaiting['observed'].coverage.unknown).toBe(1);
    expect(log.snapshots.at(-1)!['observed']).toMatchObject({
      requests: 3,
      withinBudget: true,
      coverage: { status: 'COMPLETE', unknown: 0 },
    });
  });

  it('records the first entry before the second dispatch', async () => {
    const s = scripted(allValid());
    const log = checkpointLog();
    let atSecondDispatch: Snapshot | null = null;
    await runOk({
      providerFor: (entry) => {
        const inner = log.observing(s.providerFor)(entry);
        return {
          name: inner.name,
          model: inner.model,
          draft: (request) => {
            if (entry.key === 'harbour-ledger') atSecondDispatch = onDiskCheckpoint();
            return inner.draft(request);
          },
        };
      },
      writeManifest: log.writeManifest,
    });
    expect(atSecondDispatch).not.toBeNull();
    const [first, second, third] = (atSecondDispatch as unknown as Snapshot)['entries'] as ManifestEntry[];
    expect(first).toMatchObject({
      key: 'last-tram',
      status: 'completed',
      outcome: 'REVIEW_REQUIRED',
      requests: 1,
      usage: 'REPORTED',
      approval: 'PENDING',
    });
    expect(first!.artifacts!.files).toContain('validation-report.json');
    expect(first!.routeReview).toMatchObject({ status: 'EXPORTED' });
    expect(second).toMatchObject({ key: 'harbour-ledger', status: 'awaiting_response' });
    expect(third).toMatchObject({ key: 'clock-blackout', status: 'unattempted' });
  });

  it('separates a result still being recorded from a request awaiting its response', async () => {
    const s = scripted(allValid());
    const log = checkpointLog();
    await runOk({ providerFor: s.providerFor, writeManifest: log.writeManifest });
    const recording = log.snapshots.find((x) =>
      x['entries'].some((e: ManifestEntry) => e.status === 'recording'),
    )!;
    const entry = recording['entries'].find((e: ManifestEntry) => e.status === 'recording');
    expect(entry).toMatchObject({
      outcome: 'REVIEW_REQUIRED',
      requests: 1,
      httpAttempts: 1,
      usage: 'REPORTED',
      artifacts: null,
    });
    expect(recording['completeness']).toMatchObject({ awaitingResponse: 0, recording: 1 });
    expect(recording['checkpoint'].state).toBe('IN_PROGRESS');
  });

  it('keeps result telemetry on disk when the artifact write then fails', async () => {
    const s = scripted(allValid());
    const log = checkpointLog();
    let diskWhenWriteFailed: Snapshot | null = null;
    const { manifest } = await runOk({
      providerFor: s.providerFor,
      writeManifest: log.writeManifest,
      writeRun: () => {
        diskWhenWriteFailed = onDiskCheckpoint();
        throw new Error(`disk exploded for ${SECRET}`);
      },
    });
    const persisted = (diskWhenWriteFailed as unknown as Snapshot)['entries'][0] as ManifestEntry;
    expect(persisted).toMatchObject({
      status: 'recording',
      outcome: 'REVIEW_REQUIRED',
      requests: 1,
      httpAttempts: 1,
      usage: 'REPORTED',
    });
    expect(manifest.entries[0]).toMatchObject({
      status: 'stopped',
      requests: 1,
      stop: { kind: 'ARTIFACT_WRITE_FAILED' },
    });
    expect(manifest.observed.requests).toBe(1);
    expect(s.dispatched('harbour-ledger')).toBe(0);
  });

  it('refuses to dispatch anything when the initial checkpoint cannot be written', async () => {
    const s = scripted(allValid());
    const log = checkpointLog({ failAt: (call) => call === 1 });
    const result = await run({ providerFor: s.providerFor, writeManifest: log.writeManifest });
    expect(result).toMatchObject({ ok: false, code: 'CHECKPOINT_WRITE_FAILED' });
    expect([...s.providers.values()].every((p) => p.requests.length === 0)).toBe(true);
  });

  it('refuses to dispatch when the in-flight checkpoint for an entry cannot be written', async () => {
    const s = scripted(allValid());
    // Calls: 1 initial, 2 first in-flight, 3 result, 4 recorded, 5 second in-flight.
    const log = checkpointLog({ failAt: (call) => call === 5 });
    const { manifest } = await runOk({
      providerFor: s.providerFor,
      writeManifest: log.writeManifest,
    });
    expect(s.dispatched('last-tram')).toBe(1);
    expect(s.dispatched('harbour-ledger')).toBe(0);
    expect(s.dispatched('clock-blackout')).toBe(0);
    expect(manifest.entries[1]).toMatchObject({
      key: 'harbour-ledger',
      status: 'stopped',
      outcome: null,
      usage: 'NONE',
      stop: { kind: 'CHECKPOINT_WRITE_FAILED' },
    });
    expect(manifest.entries[2]!.status).toBe('unattempted');
    expect(manifest.halt).toMatchObject({ kind: 'CHECKPOINT_WRITE_FAILED', entry: 'harbour-ledger' });
    expect(manifest.completeness.reasons).toContain('CHECKPOINT_WRITE_FAILED');
    expect(manifest.completeness.status).toBe('INCOMPLETE');
  });

  it('blocks later dispatches when the result checkpoint fails, but still records artifacts', async () => {
    const s = scripted(allValid());
    const log = checkpointLog({ failAt: (call) => call === 3 });
    const { manifest, dir } = await runOk({
      providerFor: s.providerFor,
      writeManifest: log.writeManifest,
    });
    expect(s.dispatched('last-tram')).toBe(1);
    expect(s.dispatched('harbour-ledger')).toBe(0);
    expect(manifest.entries[0]).toMatchObject({
      status: 'stopped',
      outcome: 'REVIEW_REQUIRED',
      requests: 1,
      usage: 'REPORTED',
      stop: { kind: 'CHECKPOINT_WRITE_FAILED' },
    });
    expect(manifest.entries[0]!.artifacts).not.toBeNull();
    expect(
      existsSync(path.join(dir, manifest.entries[0]!.artifacts!.dir, 'validation-report.json')),
    ).toBe(true);
    expect(manifest.halt).toMatchObject({ kind: 'CHECKPOINT_WRITE_FAILED', entry: 'last-tram' });
  });

  it('stops at once and reports the manifest as unrecorded when checkpoints keep failing', async () => {
    const s = scripted(allValid());
    const log = checkpointLog({ failAt: (call) => call >= 4 });
    const result = await run({ providerFor: s.providerFor, writeManifest: log.writeManifest });
    expect(result).toMatchObject({ ok: false, code: 'MANIFEST_WRITE_FAILED' });
    expect(s.dispatched('last-tram')).toBe(1);
    expect(s.dispatched('harbour-ledger')).toBe(0);
    expect(s.dispatched('clock-blackout')).toBe(0);
  });

  it('keeps the previous parseable checkpoint when a replacement fails', async () => {
    const s = scripted(allValid());
    let renames = 0;
    const result = await run({
      providerFor: s.providerFor,
      writeManifest: (file, text) =>
        replaceFileAtomically(file, text, {
          ...defaultReplaceOps,
          rename: (from, to) => {
            renames += 1;
            // Checkpoints 1-3 land; every later replacement fails at the final step.
            if (renames >= 4) throw new Error('rename refused');
            defaultReplaceOps.rename(from, to);
          },
        }),
    });
    expect(result).toMatchObject({ ok: false, code: 'MANIFEST_WRITE_FAILED' });
    const work = path.join(draftsRoot, readdirSync(draftsRoot)[0]!);
    const survivor = readJson(work, 'manifest.json');
    expect(survivor['checkpoint'].state).toBe('IN_PROGRESS');
    expect(survivor['entries'][0]).toMatchObject({
      status: 'recording',
      requests: 1,
      usage: 'REPORTED',
    });
    expect(readdirSync(work).filter((n) => n.endsWith('.tmp'))).toEqual([]);
    expect(s.dispatched('harbour-ledger')).toBe(0);
  });

  it('writes a final manifest that agrees with the comparison report and replaces the last checkpoint', async () => {
    const s = scripted({
      'last-tram': [{ candidate: valid(TRAM) }],
      'harbour-ledger': [{ fail: 'network' }],
    });
    const log = checkpointLog();
    const { manifest, dir } = await runOk({
      providerFor: s.providerFor,
      writeManifest: log.writeManifest,
      mode: 'openai',
    });
    const onDisk = readJson(dir, 'manifest.json');
    expect(onDisk).toEqual(JSON.parse(JSON.stringify(manifest)));
    expect(onDisk['checkpoint'].state).toBe('FINAL');
    expect(onDisk['completeness'].reasons).not.toContain('IN_PROGRESS');
    expect(onDisk['completeness']).toMatchObject({
      awaitingResponse: 0,
      recording: 0,
      completed: 1,
      stopped: 1,
      unattempted: 1,
    });
    // A provider stop that reported its counts is fully observed, not unknown.
    expect(onDisk['observed']).toMatchObject({
      requests: 2,
      withinBudget: true,
      coverage: { status: 'COMPLETE', unknown: 0 },
    });
    const report = readJson(dir, 'comparison-report.json');
    const groups = report['groups'] as Array<Record<string, any>>;
    expect(groups.reduce((n, g) => n + g['providerRequests'], 0)).toBe(onDisk['observed'].requests);
    expect(groups.reduce((n, g) => n + g['httpAttempts'], 0)).toBe(onDisk['observed'].httpAttempts);
    // Sequence numbers only ever increase.
    const sequences = log.snapshots.map((x) => x['checkpoint'].sequence as number);
    expect([...sequences].sort((a, b) => a - b)).toEqual(sequences);
    expect(new Set(sequences).size).toBe(sequences.length);
  });

  it('treats an unexpected harness failure as unknown usage rather than zero', async () => {
    const s = scripted({ 'last-tram': [{ candidate: valid(TRAM) }] });
    const { manifest } = await runOk({
      providerFor: (entry) => {
        if (entry.key === 'harbour-ledger') throw new Error(`boom ${SECRET}`);
        return s.providerFor(entry);
      },
    });
    expect(manifest.entries[1]).toMatchObject({
      status: 'stopped',
      requests: null,
      usage: 'UNKNOWN',
      stop: { kind: 'PROVIDER_STOP', reason: 'PROVIDER_ERROR' },
    });
    expect(manifest.observed.coverage).toMatchObject({ status: 'PARTIAL', unknown: 1 });
    expect(manifest.observed.withinBudget).toBeNull();
    expect(JSON.stringify(manifest)).not.toContain(SECRET);
  });
});

describe('summarizeObservation', () => {
  const budget = { maxRequests: 6, maxHttpAttempts: 6 };
  const entry = (
    usage: ManifestEntry['usage'],
    requests: number | null,
    httpAttempts: number | null,
  ): Pick<ManifestEntry, 'usage' | 'requests' | 'httpAttempts'> => ({ usage, requests, httpAttempts });

  it('is definitive within budget only when final and every entry is accounted for', () => {
    const summary = summarizeObservation(
      [entry('REPORTED', 2, 2), entry('REPORTED', 1, 1), entry('NONE', null, null)],
      budget,
      'FINAL',
    );
    expect(summary).toMatchObject({
      requests: 3,
      httpAttempts: 3,
      withinBudget: true,
      coverage: { status: 'COMPLETE', reported: 2, unknown: 0, notDispatched: 1 },
    });
  });

  it('is undetermined when an entry has unknown usage, however low the known counts are', () => {
    const summary = summarizeObservation(
      [entry('REPORTED', 1, 1), entry('UNKNOWN', null, null)],
      budget,
      'FINAL',
    );
    expect(summary.withinBudget).toBeNull();
    expect(summary.coverage).toMatchObject({ status: 'PARTIAL', unknown: 1 });
    expect(summary.requests).toBe(1);
  });

  it('is undetermined while the experiment is in progress', () => {
    const summary = summarizeObservation([entry('REPORTED', 1, 1)], budget, 'IN_PROGRESS');
    expect(summary.withinBudget).toBeNull();
    expect(summary.coverage.status).toBe('PARTIAL');
  });

  it('still reports a definite breach, because known counts are a lower bound', () => {
    const summary = summarizeObservation(
      [entry('REPORTED', 7, 7), entry('UNKNOWN', null, null)],
      budget,
      'IN_PROGRESS',
    );
    expect(summary.withinBudget).toBe(false);
  });
});

// ── Safety of what is recorded ──────────────────────────────────────────────

describe('runExperiment (what is recorded)', () => {
  it('records neither raw exception messages nor provider text', async () => {
    const leaky: ScenarioDraftProvider = {
      name: 'openai',
      model: 'model-x',
      draft: () => Promise.reject(new Error(`401 body: {"error":"${SECRET}"}`)),
    };
    const typed: ScenarioDraftProvider = {
      name: 'openai',
      model: 'model-x',
      draft: () => Promise.reject(new DraftProviderError('authentication', 1)),
    };
    for (const provider of [leaky, typed]) {
      const { dir } = await runOk({ providerFor: () => provider, mode: 'openai', model: 'model-x' });
      const text = readdirRecursiveText(dir);
      expect(text).not.toContain(SECRET);
      expect(text).not.toContain('body:');
    }
  });

  it('claims no approval, publication or prose quality', async () => {
    const { manifest } = await runOk({ providerFor: offlineProviderFor });
    const text = JSON.stringify(manifest);
    expect(manifest.notEvidenceOf.join(' ')).toMatch(/approval/i);
    expect(manifest.notEvidenceOf.join(' ')).toMatch(/prose quality/i);
    expect(text).not.toMatch(/"approved":\s*true/);
    expect(manifest.configuration.executionPolicy).toMatchObject({
      sequential: true,
      repetitionsPerBrief: 1,
      transportRetries: 0,
      automaticResume: false,
    });
  });

  it('keeps the guarded drafts-root convention: nothing is written outside the supplied root', async () => {
    const before = readdirSync(tmp);
    await runOk({ providerFor: offlineProviderFor });
    expect(readdirSync(tmp)).toEqual([...before, 'scenario-drafts'].sort());
  });
});

function readdirRecursiveText(root: string): string {
  const parts: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else parts.push(readFileSync(full, 'utf8'));
    }
  };
  walk(root);
  return parts.join('\n');
}
