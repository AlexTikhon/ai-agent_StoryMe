import { describe, expect, it } from 'vitest';
import {
  FAST_LIMITS,
  fakeClock,
  invalidCandidate,
  mutateReport,
  reportFileNameFor,
  reportText,
  runScripted,
  validCandidate,
} from '../../common/test-utils/authoring-run-fixtures';
import { runAuthoring } from './pipeline';
import { ScriptedDraftProvider } from './scripted-provider';
import { LAST_TRAM_BRIEF, LAST_TRAM_SCENARIO } from './the-last-tram';
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

// Budget-boundary fixtures. All come from the real pipeline; the zero-attempt
// repair steps leave HTTP headroom so one field can be changed in isolation.
const repairedZeroAttempt = async () =>
  runScripted([{ candidate: invalidCandidate() }, { candidate: validCandidate(), httpAttempts: 0 }]);
const rejectedZeroAttempt = async () =>
  runScripted([{ candidate: invalidCandidate() }, { candidate: invalidCandidate(), httpAttempts: 0 }]);
const stoppedDuringRepair = async () =>
  runScripted([{ candidate: invalidCandidate() }, { fail: 'network' }]);
const overrunInGeneration = async () =>
  runScripted([{ candidate: validCandidate(), httpAttempts: 3 }]);
const overrunInRepair = async () =>
  runScripted([{ candidate: invalidCandidate() }, { candidate: validCandidate(), httpAttempts: 2 }]);
// The provider exception path reports its attempts without the normal budget check.
const providerFailureOverBudget = async () => runScripted([{ fail: 'network', httpAttempts: 5 }]);
const providerFailureInRepairOverBudget = async () =>
  runScripted([{ candidate: invalidCandidate() }, { fail: 'timeout', httpAttempts: 4 }]);

async function runWithSignal(
  steps: ConstructorParameters<typeof ScriptedDraftProvider>[0],
  abortOnIdentityCheck: number | null,
) {
  const controller = new AbortController();
  if (abortOnIdentityCheck === null) controller.abort();
  let calls = 0;
  return runAuthoring({
    rawBrief: LAST_TRAM_BRIEF,
    provider: new ScriptedDraftProvider(steps),
    limits: FAST_LIMITS,
    now: fakeClock(),
    signal: controller.signal,
    // Call 1 is the brief identity check; call 2 runs inside validation of the
    // first candidate, so aborting there lands exactly before the repair dispatch.
    isPublished: () => {
      calls += 1;
      if (calls === abortOnIdentityCheck) controller.abort();
      return false;
    },
  });
}
const cancelledBeforeGeneration = async () => runWithSignal([], null);
const cancelledBeforeRepair = async () => runWithSignal([{ candidate: invalidCandidate() }], 2);

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
      'a skipped repair although the request and HTTP budgets both remained',
      async () => reportText(await budgetExhausted()),
      'run-report.json',
      (r) => {
        r.provenance.requests[0].httpAttempts = 1;
        r.provenance.totalHttpAttempts = 1;
      },
      'repair-disposition',
    ],
    [
      'a repair dispatched after generation exhausted the HTTP budget',
      async () => reportText(await repairedZeroAttempt()),
      'validation-report.json',
      (r) => {
        r.provenance.requests[0].httpAttempts = 2;
        r.provenance.totalHttpAttempts = 2;
      },
      'repair-budget',
    ],
    [
      'a rejected repair dispatched after generation exhausted the HTTP budget',
      async () => reportText(await rejectedZeroAttempt()),
      'run-report.json',
      (r) => {
        r.provenance.requests[0].httpAttempts = 2;
        r.provenance.totalHttpAttempts = 2;
      },
      'repair-budget',
    ],
    [
      'a repair stopped after generation exhausted the HTTP budget',
      async () => reportText(await stoppedDuringRepair()),
      'run-report.json',
      (r) => {
        r.provenance.requests[0].httpAttempts = 2;
        r.provenance.totalHttpAttempts = 3;
      },
      'repair-budget',
    ],
    [
      'a pre-repair cancellation after generation exhausted the HTTP budget',
      async () => reportText(await cancelledBeforeRepair()),
      'run-report.json',
      (r) => {
        r.provenance.requests[0].httpAttempts = 2;
        r.provenance.totalHttpAttempts = 2;
      },
      'repair-budget',
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

describe('parseRunReport: budget consistency on genuine pipeline reports', () => {
  const accepted: Array<[string, () => ReturnType<typeof firstPass>, Record<string, unknown>]> = [
    ['an exhausted HTTP budget that skipped repair', budgetExhausted, { status: 'REJECTED', repairDisposition: 'skipped_budget_exhausted' }],
    ['a repaired success', repaired, { status: 'REVIEW_REQUIRED', repaired: true }],
    ['a repaired success with a zero-attempt repair', repairedZeroAttempt, { status: 'REVIEW_REQUIRED', repaired: true }],
    ['a repaired rejection', rejected, { status: 'REJECTED', repairDisposition: 'attempted' }],
    ['a stop during generation', stopped, { status: 'STOPPED', stopPhase: 'generate', stopReason: 'NETWORK' }],
    ['a stop during repair', stoppedDuringRepair, { status: 'STOPPED', stopPhase: 'repair', stopReason: 'NETWORK' }],
    ['a cancellation before generation is dispatched', cancelledBeforeGeneration, { status: 'STOPPED', stopPhase: 'generate', stopReason: 'CANCELLED' }],
    ['a cancellation before repair is dispatched', cancelledBeforeRepair, { status: 'STOPPED', stopPhase: 'repair', stopReason: 'CANCELLED' }],
    ['a call-budget overrun in generation', overrunInGeneration, { status: 'STOPPED', stopPhase: 'generate', stopReason: 'CALL_BUDGET_EXCEEDED' }],
    ['a call-budget overrun in repair', overrunInRepair, { status: 'STOPPED', stopPhase: 'repair', stopReason: 'CALL_BUDGET_EXCEEDED' }],
    ['a provider failure that reported attempts over budget', providerFailureOverBudget, { status: 'STOPPED', stopPhase: 'generate', stopReason: 'NETWORK' }],
    ['a provider failure in repair that reported attempts over budget', providerFailureInRepairOverBudget, { status: 'STOPPED', stopPhase: 'repair', stopReason: 'TIMEOUT' }],
  ];

  it.each(accepted)('accepts %s', async (_name, make, expected) => {
    const outcome = await parsed(make);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.observation).toMatchObject(expected);
  });

  it('accepts a skipped repair when the declared request budget is already used', async () => {
    const text = mutateReport(reportText(await budgetExhausted()), (r) => {
      r.provenance.requests[0].httpAttempts = 1;
      r.provenance.totalHttpAttempts = 1;
      r.provenance.callBudget.maxRequests = 1;
    });
    const outcome = parseRunReport('run-report.json', text);
    expect(outcome.ok).toBe(true);
  });

  it('keeps failure details to a fixed vocabulary', async () => {
    const text = mutateReport(reportText(await repairedZeroAttempt()), (r) => {
      r.provenance.requests[0].httpAttempts = 2;
      r.provenance.totalHttpAttempts = 2;
    });
    const outcome = parseRunReport('validation-report.json', text);
    expect(outcome).toEqual({ ok: false, code: 'INCONSISTENT_TELEMETRY', detail: 'repair-budget' });
  });
});
