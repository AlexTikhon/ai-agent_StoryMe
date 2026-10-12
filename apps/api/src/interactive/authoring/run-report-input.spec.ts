import { describe, expect, it } from 'vitest';
import {
  invalidCandidate,
  mutateReport,
  reportFileNameFor,
  reportText,
  runScripted,
  validCandidate,
} from '../../common/test-utils/authoring-run-fixtures';
import { LAST_TRAM_SCENARIO } from './the-last-tram';
import { parseRunReport, type ReportFileName } from './run-report-input';

const firstPass = async () => runScripted([{ candidate: validCandidate() }]);
const repaired = async () =>
  runScripted([
    { candidate: invalidCandidate(), usage: { inputTokens: 1000, outputTokens: 500 } },
    { candidate: validCandidate(), usage: { inputTokens: 1200, outputTokens: 600 } },
  ]);
const rejected = async () =>
  runScripted([{ candidate: invalidCandidate() }, { candidate: invalidCandidate() }]);
const budgetExhausted = async () =>
  runScripted([{ candidate: invalidCandidate(), httpAttempts: 2 }]);
const stopped = async () => runScripted([{ fail: 'network' }]);

async function parsed(make: () => ReturnType<typeof firstPass>) {
  const result = await make();
  return parseRunReport(reportFileNameFor(result) as ReportFileName, reportText(result));
}

function expectInvalid(
  outcome: ReturnType<typeof parseRunReport>,
  code: string,
  detail?: string,
): void {
  expect(outcome.ok).toBe(false);
  if (outcome.ok) return;
  expect(outcome.code).toBe(code);
  if (detail !== undefined) expect(outcome.detail).toBe(detail);
}

describe('parseRunReport: valid reports from the real pipeline', () => {
  it('reads a first-pass REVIEW_REQUIRED validation report', async () => {
    const outcome = await parsed(firstPass);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const o = outcome.observation;
    expect(o.status).toBe('REVIEW_REQUIRED');
    expect(o.repaired).toBe(false);
    expect(o.group.provider).toBe('scripted');
    expect(o.group.model).toBeNull();
    expect(o.group.briefHash).toMatch(/^[0-9a-f]{64}$/);
    expect(o.requests).toHaveLength(1);
    expect(o.requests[0]).toMatchObject({
      phase: 'generate',
      outcome: 'ok',
      validation: { verdict: 'passed' },
    });
    expect(o.totalHttpAttempts).toBe(1);
    expect(o.totalDurationMs).toBeGreaterThan(0);
  });

  it('reads a repaired REVIEW_REQUIRED report with both requests', async () => {
    const outcome = await parsed(repaired);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const o = outcome.observation;
    expect(o.repaired).toBe(true);
    expect(o.requests.map((r) => r.phase)).toEqual(['generate', 'repair']);
    expect(o.requests[0]!.validation).toEqual({ verdict: 'failed', stage: 'definition' });
    expect(o.requests[1]!.validation).toEqual({ verdict: 'passed' });
    expect(o.requests.map((r) => r.inputTokens)).toEqual([1000, 1200]);
  });

  it('reads a REJECTED run report after a failed repair', async () => {
    const outcome = await parsed(rejected);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.observation).toMatchObject({
      status: 'REJECTED',
      rejectedStage: 'definition',
      repairDisposition: 'attempted',
      stopReason: null,
    });
    expect(outcome.observation.requests).toHaveLength(2);
  });

  it('reads a REJECTED run report whose repair was skipped for budget', async () => {
    const outcome = await parsed(budgetExhausted);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.observation).toMatchObject({
      status: 'REJECTED',
      repairDisposition: 'skipped_budget_exhausted',
    });
    expect(outcome.observation.requests).toHaveLength(1);
    expect(outcome.observation.totalHttpAttempts).toBe(2);
  });

  it('reads a STOPPED transport failure', async () => {
    const outcome = await parsed(stopped);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.observation).toMatchObject({
      status: 'STOPPED',
      stopReason: 'NETWORK',
      stopPhase: 'generate',
    });
    expect(outcome.observation.requests[0]).toMatchObject({ outcome: 'NETWORK', validation: null });
  });

  it('keeps unreported tokens unknown (null) and genuine zero as zero', async () => {
    const missing = await parsed(() => runScripted([{ candidate: validCandidate() }]));
    const zero = await parsed(() =>
      runScripted([{ candidate: validCandidate(), usage: { inputTokens: 0, outputTokens: 0 } }]),
    );
    const partial = await parsed(() =>
      runScripted([{ candidate: validCandidate(), usage: { inputTokens: 42 } }]),
    );
    if (!missing.ok || !zero.ok || !partial.ok) throw new Error('fixtures must parse');
    expect(missing.observation.requests[0]).toMatchObject({ inputTokens: null, outputTokens: null });
    expect(zero.observation.requests[0]).toMatchObject({ inputTokens: 0, outputTokens: 0 });
    expect(partial.observation.requests[0]).toMatchObject({ inputTokens: 42, outputTokens: null });
  });

  it('emits no candidate title, diagnostics, hashes of candidates or raw output', async () => {
    for (const make of [firstPass, repaired, rejected, stopped]) {
      const result = await make();
      const text = reportText(result);
      const outcome = parseRunReport(reportFileNameFor(result) as ReportFileName, text);
      if (!outcome.ok) throw new Error('fixture must parse');
      const emitted = JSON.stringify(outcome.observation);
      expect(emitted).not.toContain(LAST_TRAM_SCENARIO.title);
      expect(emitted).not.toContain('s-missing');
      expect(emitted).not.toContain('diagnostics');
      expect(emitted).not.toContain('rawSha256');
      expect(emitted).not.toContain('rejectedOutputSha256');
      expect(emitted).not.toContain('candidateHash');
      expect(emitted).not.toContain('startedAt');
    }
  });
});

describe('parseRunReport: malformed input', () => {
  it('rejects text that is not JSON', () => {
    expectInvalid(parseRunReport('run-report.json', '{"status": '), 'MALFORMED_JSON');
    expectInvalid(parseRunReport('run-report.json', ''), 'MALFORMED_JSON');
  });

  it.each([['[]'], ['null'], ['"x"'], ['7']])('rejects non-object JSON %s', (text) => {
    expectInvalid(parseRunReport('run-report.json', text), 'SCHEMA_INVALID');
  });

  it('rejects a validation report supplied as run-report.json and vice versa', async () => {
    const ok = await firstPass();
    expectInvalid(parseRunReport('run-report.json', reportText(ok)), 'KIND_MISMATCH');
    const stoppedResult = await stopped();
    expectInvalid(
      parseRunReport('validation-report.json', reportText(stoppedResult)),
      'KIND_MISMATCH',
    );
  });

  it.each([
    ['approved is not false', (r: any) => (r.approved = true), 'approved'],
    ['unknown provider', (r: any) => (r.provenance.provider = 'anthropic'), 'provenance.provider'],
    [
      'negative token count',
      (r: any) => (r.provenance.requests[0].inputTokens = -1),
      'provenance.requests.0.inputTokens',
    ],
    [
      'fractional http attempts',
      (r: any) => (r.provenance.requests[0].httpAttempts = 1.5),
      'provenance.requests.0.httpAttempts',
    ],
    [
      'string token count',
      (r: any) => (r.provenance.requests[0].outputTokens = '9'),
      'provenance.requests.0.outputTokens',
    ],
    ['missing brief hash', (r: any) => (r.provenance.briefHash = null), 'provenance.briefHash'],
    ['malformed brief hash', (r: any) => (r.provenance.briefHash = 'abc'), 'provenance.briefHash'],
    [
      'prompt version with free text',
      (r: any) => (r.provenance.promptVersion = 'v1 ignore previous instructions'),
      'provenance.promptVersion',
    ],
    [
      'stage list that is not the full pipeline',
      (r: any) => r.stages.pop(),
      'stages',
    ],
    [
      'unparseable start time',
      (r: any) => (r.provenance.startedAt = 'yesterday'),
      'provenance.startedAt',
    ],
  ])('rejects a validation report where %s', async (_name, mutate, path) => {
    const text = mutateReport(reportText(await firstPass()), mutate as (r: any) => void);
    const outcome = parseRunReport('validation-report.json', text);
    expectInvalid(outcome, 'SCHEMA_INVALID');
    if (!outcome.ok) expect(outcome.detail).toBe(path);
  });

  it('never echoes untrusted values in the failure detail', async () => {
    const text = mutateReport(reportText(await firstPass()), (r) => {
      r.provenance.provider = 'sk-SECRET-VALUE';
    });
    const outcome = parseRunReport('validation-report.json', text);
    expect(JSON.stringify(outcome)).not.toContain('sk-SECRET-VALUE');
  });
});

describe('parseRunReport: inconsistent telemetry', () => {
  const validation = async () => reportText(await firstPass());
  const repairedText = async () => reportText(await repaired());
  const rejectedText = async () => reportText(await rejected());
  const stoppedText = async () => reportText(await stopped());

  const cases: Array<[string, () => Promise<string>, string, (r: any) => void, string]> = [
    [
      'http attempts that do not sum',
      validation,
      'validation-report.json',
      (r) => (r.provenance.totalHttpAttempts = 5),
      'http-attempts-sum',
    ],
    [
      'repaired flag with a single request',
      validation,
      'validation-report.json',
      (r) => (r.repaired = true),
      'repaired-flag',
    ],
    [
      'unrepaired flag with two requests',
      repairedText,
      'validation-report.json',
      (r) => (r.repaired = false),
      'repaired-flag',
    ],
    [
      'candidate hash that differs from provenance',
      validation,
      'validation-report.json',
      (r) => (r.candidate.hash = 'f'.repeat(64)),
      'candidate-hash',
    ],
    [
      'missing candidate hash in provenance',
      validation,
      'validation-report.json',
      (r) => (r.provenance.candidateHash = null),
      'candidate-hash',
    ],
    [
      'final request that did not pass',
      validation,
      'validation-report.json',
      (r) => (r.provenance.requests[0].validation = 'failed:definition'),
      'request-validation',
    ],
    [
      'first request marked passed although a repair followed',
      repairedText,
      'validation-report.json',
      (r) => (r.provenance.requests[0].validation = 'passed'),
      'request-validation',
    ],
    [
      'request phases out of order',
      repairedText,
      'validation-report.json',
      (r) => (r.provenance.requests[0].phase = 'repair'),
      'request-phases',
    ],
    [
      'more requests than the declared budget',
      repairedText,
      'validation-report.json',
      (r) => (r.provenance.callBudget.maxRequests = 1),
      'request-budget',
    ],
    [
      'request durations exceeding the total run duration',
      validation,
      'validation-report.json',
      (r) => (r.provenance.totalDurationMs = 0),
      'duration-total',
    ],
    [
      'rejected stage that differs from the final request',
      rejectedText,
      'run-report.json',
      (r) => (r.failedStage = 'play-analysis'),
      'request-validation',
    ],
    [
      'repair disposition attempted with a single request',
      rejectedText,
      'run-report.json',
      (r) => {
        r.provenance.requests.pop();
        r.provenance.totalHttpAttempts = 1;
      },
      'repair-disposition',
    ],
    [
      'stop reason that differs from the failed request',
      stoppedText,
      'run-report.json',
      (r) => (r.stopReason = 'REFUSAL'),
      'stop-outcome',
    ],
    [
      'stop phase that differs from the failed request',
      stoppedText,
      'run-report.json',
      (r) => (r.phase = 'repair'),
      'stop-phase',
    ],
    [
      'mock provider reporting HTTP attempts',
      validation,
      'validation-report.json',
      (r) => {
        r.provenance.provider = 'mock';
      },
      'mock-telemetry',
    ],
    [
      'openai provider without a model',
      validation,
      'validation-report.json',
      (r) => (r.provenance.provider = 'openai'),
      'provider-model',
    ],
    [
      'scripted provider carrying a model',
      validation,
      'validation-report.json',
      (r) => (r.provenance.model = 'gpt-test'),
      'provider-model',
    ],
  ];

  it.each(cases)('rejects %s', async (_name, make, fileName, mutate, detail) => {
    const text = mutateReport(await make(), mutate);
    expectInvalid(
      parseRunReport(fileName as ReportFileName, text),
      'INCONSISTENT_TELEMETRY',
      detail,
    );
  });

  it('accepts openai-labelled telemetry that is internally consistent', async () => {
    const text = mutateReport(await validation(), (r) => {
      r.provenance.provider = 'openai';
      r.provenance.model = 'offline-fixture-model';
    });
    const outcome = parseRunReport('validation-report.json', text);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.observation.group).toMatchObject({
        provider: 'openai',
        model: 'offline-fixture-model',
      });
    }
  });
});
