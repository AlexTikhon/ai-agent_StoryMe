import { describe, expect, it } from 'vitest';
import {
  fakeClock,
  FAST_LIMITS,
  invalidCandidate,
  mutateReport,
  reportFileNameFor,
  reportText,
  runScripted,
  validCandidate,
} from '../../common/test-utils/authoring-run-fixtures';
import { VALIDATION_STAGES } from './diagnostics';
import { runAuthoring, type AuthoringResult } from './pipeline';
import { MockScenarioDraftProvider } from './provider';
import {
  buildComparisonReport,
  COMPARISON_REPORT_SCHEMA,
  type ComparisonReport,
} from './run-report-aggregate';
import {
  parseRunReport,
  STOP_REASONS,
  type ReportFileName,
  type RunObservation,
} from './run-report-input';
import { LAST_TRAM_BRIEF, LAST_TRAM_SCENARIO } from './the-last-tram';

function observe(result: AuthoringResult, mutate?: (r: Record<string, any>) => void): RunObservation {
  const text = mutate ? mutateReport(reportText(result), mutate) : reportText(result);
  const outcome = parseRunReport(reportFileNameFor(result) as ReportFileName, text);
  if (!outcome.ok) throw new Error(`fixture must parse: ${outcome.code}/${outcome.detail}`);
  return outcome.observation;
}

const usage = (inputTokens: number, outputTokens: number) => ({ inputTokens, outputTokens });

async function mixedRuns() {
  return {
    firstPass: await runScripted([{ candidate: validCandidate(), usage: usage(100, 50) }], {
      stepMs: 5,
    }),
    repaired: await runScripted(
      [
        { candidate: invalidCandidate(), usage: usage(1000, 500) },
        { candidate: validCandidate(), usage: usage(1200, 600) },
      ],
      { stepMs: 10 },
    ),
    rejected: await runScripted(
      [{ candidate: invalidCandidate() }, { candidate: invalidCandidate() }],
      { stepMs: 20 },
    ),
    budget: await runScripted([{ candidate: invalidCandidate(), httpAttempts: 2 }], {
      stepMs: 30,
    }),
    networkStop: await runScripted([{ fail: 'network' }], { stepMs: 40 }),
    refusalDuringRepair: await runScripted(
      [{ candidate: invalidCandidate() }, { fail: 'refusal' }],
      { stepMs: 50 },
    ),
  };
}

function numbersIn(value: unknown, found: number[] = []): number[] {
  if (typeof value === 'number') found.push(value);
  else if (Array.isArray(value)) value.forEach((v) => numbersIn(v, found));
  else if (value && typeof value === 'object') {
    Object.values(value).forEach((v) => numbersIn(v, found));
  }
  return found;
}

function keysIn(value: unknown, found = new Set<string>()): Set<string> {
  if (Array.isArray(value)) value.forEach((v) => keysIn(v, found));
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      found.add(k);
      keysIn(v, found);
    }
  }
  return found;
}

describe('buildComparisonReport: exact denominators', () => {
  it('summarizes one mixed group with explicit denominators', async () => {
    const runs = await mixedRuns();
    const observations = Object.values(runs).map((r) => observe(r));
    const report = buildComparisonReport(observations);

    expect(report.schema).toBe(COMPARISON_REPORT_SCHEMA);
    expect(report.inputs).toEqual({ reports: 6, groups: 1 });
    const g = report.groups[0]!;
    expect(g.key).toEqual({
      provider: 'scripted',
      model: null,
      promptVersion: observations[0]!.group.promptVersion,
      wireSchemaVersion: observations[0]!.group.wireSchemaVersion,
      briefHash: observations[0]!.group.briefHash,
    });
    expect(g.samples).toBe(6);
    expect(g.outcomes).toEqual({ reviewRequired: 2, rejected: 2, stopped: 2 });

    // 5 runs validated a first candidate; the network stop never produced one.
    expect(g.firstPass).toEqual({ evaluated: 5, passed: 1, notEvaluated: 1, rate: 0.2 });

    // 3 repair requests: 2 produced a validated candidate (1 passed), 1 stopped.
    expect(g.repair).toEqual({
      attempted: 3,
      evaluated: 2,
      succeeded: 1,
      stoppedDuringRepair: 1,
      skippedBudgetExhausted: 1,
      successRate: 0.5,
    });

    // The two stopped runs are not in the final-validity denominator, but stay in `outcomes`.
    expect(g.finalValidity).toEqual({ evaluated: 4, valid: 2, rate: 0.5 });

    expect(g.rejectionStages.definition).toBe(2);
    expect(Object.keys(g.rejectionStages)).toEqual([...VALIDATION_STAGES]);
    expect(Object.values(g.rejectionStages).reduce((a, b) => a + b, 0)).toBe(2);
    expect(Object.keys(g.stopReasons)).toEqual(STOP_REASONS);
    expect(g.stopReasons.NETWORK).toBe(1);
    expect(g.stopReasons.REFUSAL).toBe(1);
    expect(Object.values(g.stopReasons).reduce((a, b) => a + b, 0)).toBe(2);

    expect(g.providerRequests).toBe(9);
    expect(g.httpAttempts).toBe(10);
  });

  it('summarizes total-run duration from the supplied totals only', async () => {
    const observations = Object.values(await mixedRuns()).map((r) => observe(r));
    const durations = observations.map((o) => o.totalDurationMs).sort((a, b) => a - b);
    const d = buildComparisonReport(observations).groups[0]!.totalRunDurationMs;
    expect(d.samples).toBe(6);
    expect(d.minMs).toBe(durations[0]);
    expect(d.maxMs).toBe(durations[5]);
    expect(d.medianMs).toBe((durations[2]! + durations[3]!) / 2);
    expect(d.meanMs).toBe(Math.round((durations.reduce((a, b) => a + b, 0) / 6) * 100) / 100);
  });

  it('sums only reported tokens and states how much of the group reported', async () => {
    const observations = Object.values(await mixedRuns()).map((r) => observe(r));
    const { tokenUsage } = buildComparisonReport(observations).groups[0]!;
    // Only the first-pass run (1 request) and the repaired run (2 requests) reported usage.
    expect(tokenUsage.input).toEqual({
      reportedTotal: 100 + 1000 + 1200,
      requestsReporting: 3,
      requestsObserved: 9,
      coverage: 0.3333,
      complete: false,
    });
    expect(tokenUsage.output).toEqual({
      reportedTotal: 50 + 500 + 600,
      requestsReporting: 3,
      requestsObserved: 9,
      coverage: 0.3333,
      complete: false,
    });
  });

  it('keeps unknown usage null and a genuine zero as zero', async () => {
    const unknown = buildComparisonReport([
      observe(await runScripted([{ candidate: validCandidate() }])),
    ]).groups[0]!.tokenUsage;
    expect(unknown.input).toEqual({
      reportedTotal: null,
      requestsReporting: 0,
      requestsObserved: 1,
      coverage: 0,
      complete: false,
    });
    expect(unknown.output.reportedTotal).toBeNull();

    const zero = buildComparisonReport([
      observe(await runScripted([{ candidate: validCandidate(), usage: usage(0, 0) }])),
    ]).groups[0]!.tokenUsage;
    expect(zero.input).toEqual({
      reportedTotal: 0,
      requestsReporting: 1,
      requestsObserved: 1,
      coverage: 1,
      complete: true,
    });
  });

  it('treats input and output coverage independently', async () => {
    const report = buildComparisonReport([
      observe(
        await runScripted([{ candidate: validCandidate(), usage: { inputTokens: 10 } }]),
      ),
    ]);
    const { input, output } = report.groups[0]!.tokenUsage;
    expect(input.reportedTotal).toBe(10);
    expect(input.complete).toBe(true);
    expect(output.reportedTotal).toBeNull();
    expect(output.complete).toBe(false);
  });

  it('never produces NaN or a rate for an empty denominator', async () => {
    const controller = new AbortController();
    controller.abort();
    const preAborted = await runAuthoring({
      rawBrief: LAST_TRAM_BRIEF,
      provider: new (await import('./scripted-provider')).ScriptedDraftProvider([]),
      limits: FAST_LIMITS,
      signal: controller.signal,
      now: fakeClock(),
    });
    expect(preAborted.status).toBe('STOPPED');

    const report = buildComparisonReport([observe(preAborted)]);
    const g = report.groups[0]!;
    expect(g.samples).toBe(1);
    expect(g.providerRequests).toBe(0);
    expect(g.firstPass).toEqual({ evaluated: 0, passed: 0, notEvaluated: 1, rate: null });
    expect(g.repair.successRate).toBeNull();
    expect(g.finalValidity).toEqual({ evaluated: 0, valid: 0, rate: null });
    expect(g.tokenUsage.input).toEqual({
      reportedTotal: null,
      requestsReporting: 0,
      requestsObserved: 0,
      coverage: null,
      complete: false,
    });
    expect(g.stopReasons.CANCELLED).toBe(1);
    for (const n of numbersIn(report)) expect(Number.isFinite(n)).toBe(true);
  });

  it('reports an empty comparison without groups', () => {
    const report = buildComparisonReport([]);
    expect(report.inputs).toEqual({ reports: 0, groups: 0 });
    expect(report.groups).toEqual([]);
  });
});

describe('buildComparisonReport: grouping and evidence', () => {
  it('never merges runs that differ in provider, model, prompt, wire schema or brief', async () => {
    const result = await runScripted([{ candidate: validCandidate() }]);
    const variants: Array<(r: Record<string, any>) => void> = [
      () => undefined,
      (r) => {
        r.provenance.provider = 'openai';
        r.provenance.model = 'model-a';
      },
      (r) => {
        r.provenance.provider = 'openai';
        r.provenance.model = 'model-b';
      },
      (r) => (r.provenance.promptVersion = 'interactive-authoring-prompt/v2'),
      (r) => (r.provenance.schemaVersion = 'interactive-authoring-wire/v2'),
      (r) => (r.provenance.briefHash = 'b'.repeat(64)),
    ];
    const report = buildComparisonReport(variants.map((v) => observe(result, v)));
    expect(report.groups).toHaveLength(variants.length);
    expect(report.groups.every((g) => g.samples === 1)).toBe(true);
    expect(report.inputs).toEqual({ reports: 6, groups: 6 });
  });

  it('merges identical group keys and keeps mock, scripted and OpenAI-labelled runs distinct', async () => {
    const scripted = await runScripted([{ candidate: validCandidate() }]);
    const mock = await runAuthoring({
      rawBrief: LAST_TRAM_BRIEF,
      provider: new MockScenarioDraftProvider(),
      limits: FAST_LIMITS,
      now: fakeClock(),
    });
    const openaiLabelled = (r: Record<string, any>) => {
      r.provenance.provider = 'openai';
      r.provenance.model = 'offline-fixture-model';
    };
    const report = buildComparisonReport([
      observe(scripted),
      observe(scripted),
      observe(mock),
      observe(scripted, openaiLabelled),
    ]);
    const byProvider = Object.fromEntries(report.groups.map((g) => [g.key.provider, g]));
    expect(report.groups).toHaveLength(3);
    expect(byProvider['scripted']!.samples).toBe(2);
    expect(byProvider['mock']!.samples).toBe(1);
    expect(byProvider['openai']!.samples).toBe(1);
    expect(byProvider['mock']!.evidenceClass).toBe('OFFLINE_MOCK');
    expect(byProvider['scripted']!.evidenceClass).toBe('OFFLINE_SCRIPTED');
    expect(byProvider['openai']!.evidenceClass).toBe('OPENAI_LABELLED');
    // A mock request is recorded but dispatches no HTTP attempt.
    expect(byProvider['mock']!.providerRequests).toBe(1);
    expect(byProvider['mock']!.httpAttempts).toBe(0);
  });

  it('orders groups and output identically for any input order', async () => {
    const runs = Object.values(await mixedRuns());
    const observations = [
      ...runs.map((r) => observe(r)),
      ...runs.map((r) =>
        observe(r, (rep) => {
          rep.provenance.provider = 'openai';
          rep.provenance.model = 'offline-fixture-model';
        }),
      ),
    ];
    const forward = JSON.stringify(buildComparisonReport(observations));
    const backward = JSON.stringify(buildComparisonReport([...observations].reverse()));
    const shuffled = JSON.stringify(
      buildComparisonReport(observations.filter((_, i) => i % 2 === 0).concat(
        observations.filter((_, i) => i % 2 === 1),
      )),
    );
    expect(backward).toBe(forward);
    expect(shuffled).toBe(forward);
    const providers = buildComparisonReport(observations).groups.map((g) => g.key.provider);
    expect(providers).toEqual(['openai', 'scripted']);
  });
});

describe('buildComparisonReport: output allowlist and labelling', () => {
  it('labels itself as observations and never claims quality, approval or cost', async () => {
    const report: ComparisonReport = buildComparisonReport(
      Object.values(await mixedRuns()).map((r) => observe(r)),
    );
    expect(report.evidenceLabel).toBe('OBSERVATIONS_FROM_SUPPLIED_ARTIFACTS');
    const text = report.limitations.join('\n');
    expect(text).toMatch(/mechanical validity/i);
    expect(text).toMatch(/not editorial approval/i);
    expect(text).toMatch(/provider label/i);
    expect(text).toMatch(/real-model quality/i);
    const keys = keysIn(report);
    for (const forbidden of ['cost', 'estimatedCost', 'approved', 'quality', 'score']) {
      expect(keys.has(forbidden)).toBe(false);
    }
  });

  it('contains only allowlisted keys and no source, candidate or diagnostic content', async () => {
    const report = buildComparisonReport(
      Object.values(await mixedRuns()).map((r) => observe(r)),
    );
    const allowed = new Set([
      'schema', 'evidenceLabel', 'limitations', 'definitions', 'inputs', 'reports', 'groups',
      'key', 'provider', 'model', 'promptVersion', 'wireSchemaVersion', 'briefHash',
      'evidenceClass', 'samples', 'outcomes', 'reviewRequired', 'rejected', 'stopped',
      'firstPass', 'evaluated', 'passed', 'notEvaluated', 'rate',
      'repair', 'attempted', 'succeeded', 'stoppedDuringRepair', 'skippedBudgetExhausted',
      'successRate', 'finalValidity', 'valid',
      'rejectionStages', 'stopReasons', 'providerRequests', 'httpAttempts',
      'totalRunDurationMs', 'minMs', 'medianMs', 'maxMs', 'meanMs',
      'tokenUsage', 'input', 'output', 'reportedTotal', 'requestsReporting', 'requestsObserved',
      'coverage', 'complete',
      ...VALIDATION_STAGES, ...STOP_REASONS,
    ]);
    const unexpected = [...keysIn(report)].filter((k) => !allowed.has(k));
    expect(unexpected).toEqual([]);
    const text = JSON.stringify(report);
    expect(text).not.toContain(LAST_TRAM_SCENARIO.title);
    expect(text).not.toContain('s-missing');
    expect(text).not.toMatch(/scenario-drafts|validation-report|run-report|\.json/);
  });
});
