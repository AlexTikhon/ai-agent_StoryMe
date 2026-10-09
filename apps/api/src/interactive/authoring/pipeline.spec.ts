import { describe, expect, it } from 'vitest';
import { listScenarioIds, getScenario } from '../scenarios';
import type { DraftFailureKind } from './provider';
import { MockScenarioDraftProvider } from './provider';
import { runAuthoring, type AuthoringResult, type StopReason } from './pipeline';
import { ScriptedDraftProvider } from './scripted-provider';
import { LAST_TRAM_BRIEF, LAST_TRAM_SCENARIO } from './the-last-tram';
import { scenarioToWire } from './wire';

const validText = () => JSON.stringify(scenarioToWire(LAST_TRAM_SCENARIO));
const invalidText = () => {
  const w = structuredClone(scenarioToWire(LAST_TRAM_SCENARIO));
  w.scenes[1]!.choices[0]!.to = 's-missing';
  return JSON.stringify(w);
};
const run = (
  provider: ScriptedDraftProvider,
  extra: Partial<Parameters<typeof runAuthoring>[0]> = {},
) => runAuthoring({ rawBrief: LAST_TRAM_BRIEF, provider, ...extra });

function only<S extends AuthoringResult['status']>(result: AuthoringResult, status: S) {
  expect(result.status).toBe(status);
  return result as Extract<AuthoringResult, { status: S }>;
}

describe('runAuthoring with the offline mock', () => {
  it('yields REVIEW_REQUIRED, never an approval, using zero HTTP attempts', async () => {
    const provider = new MockScenarioDraftProvider();
    const result = only(
      await runAuthoring({ rawBrief: LAST_TRAM_BRIEF, provider }),
      'REVIEW_REQUIRED',
    );
    expect(result.approved).toBe(false);
    expect(result.repaired).toBe(false);
    expect(result.scenario).toEqual(LAST_TRAM_SCENARIO);
    expect(result.provenance.requests).toHaveLength(1);
    expect(result.provenance.totalHttpAttempts).toBe(0);
    expect(result.provenance.provider).toBe('mock');
    expect(result.provenance.model).toBeNull();
    expect(result.provenance.candidateHash).toBe(result.candidateHash);
  });

  it('is reproducible: repeated runs give the same candidate and brief hashes', async () => {
    const a = only(
      await runAuthoring({ rawBrief: LAST_TRAM_BRIEF, provider: new MockScenarioDraftProvider() }),
      'REVIEW_REQUIRED',
    );
    const b = only(
      await runAuthoring({ rawBrief: LAST_TRAM_BRIEF, provider: new MockScenarioDraftProvider() }),
      'REVIEW_REQUIRED',
    );
    expect(a.candidateHash).toBe(b.candidateHash);
    expect(a.provenance.briefHash).toBe(b.provenance.briefHash);
    expect(a.validation).toEqual(b.validation);
  });

  it('never registers the candidate as published content', async () => {
    await runAuthoring({ rawBrief: LAST_TRAM_BRIEF, provider: new MockScenarioDraftProvider() });
    expect(listScenarioIds()).toEqual(['warsaw-last-delivery']);
    expect(getScenario('warsaw-last-tram', 1)).toBeUndefined();
  });

  it('records provenance versions and no invented cost', async () => {
    const result = only(
      await runAuthoring({ rawBrief: LAST_TRAM_BRIEF, provider: new MockScenarioDraftProvider() }),
      'REVIEW_REQUIRED',
    );
    expect(result.provenance.promptVersion).toBe('interactive-authoring-prompt/v1');
    expect(result.provenance.schemaVersion).toBe('interactive-authoring-wire/v1');
    expect(JSON.stringify(result.provenance).toLowerCase()).not.toMatch(/cost|price|usd|dollar/);
    expect(result.provenance.requests[0]).not.toHaveProperty('inputTokens');
  });
});

describe('brief and identity gates run before any provider call', () => {
  it('refuses an invalid brief without calling the provider', async () => {
    const provider = new ScriptedDraftProvider([{ candidate: validText() }]);
    const result = only(
      await runAuthoring({ rawBrief: { ...LAST_TRAM_BRIEF, characters: [] }, provider }),
      'BRIEF_REJECTED',
    );
    expect(result.code).toBe('BRIEF_INVALID');
    expect(provider.requests).toHaveLength(0);
  });

  it('refuses a candidate identity already published in the registry', async () => {
    const provider = new ScriptedDraftProvider([{ candidate: validText() }]);
    const result = only(
      await runAuthoring({
        rawBrief: { ...LAST_TRAM_BRIEF, scenarioId: 'warsaw-last-delivery' },
        provider,
      }),
      'BRIEF_REJECTED',
    );
    expect(result.code).toBe('IDENTITY_ALREADY_PUBLISHED');
    expect(provider.requests).toHaveLength(0);
  });
});

describe('bounded repair', () => {
  it('repairs once: the repaired candidate passes the whole pipeline again', async () => {
    const provider = new ScriptedDraftProvider([
      { candidate: invalidText(), usage: { inputTokens: 900, outputTokens: 400 } },
      { candidate: validText(), usage: { inputTokens: 1500, outputTokens: 420 } },
    ]);
    const result = only(await run(provider), 'REVIEW_REQUIRED');
    expect(result.repaired).toBe(true);
    expect(result.approved).toBe(false);
    expect(provider.requests.map((r) => r.kind)).toEqual(['generate', 'repair']);
    expect(result.provenance.requests.map((r) => r.validation)).toEqual([
      'failed:definition',
      'passed',
    ]);
    expect(result.provenance.totalHttpAttempts).toBe(2);
    expect(result.provenance.requests[1]).toMatchObject({ inputTokens: 1500, outputTokens: 420 });
  });

  it('gives the repair request only bounded diagnostics and the bounded candidate', async () => {
    const provider = new ScriptedDraftProvider([
      { candidate: invalidText() },
      { candidate: validText() },
    ]);
    await run(provider);
    const repair = provider.requests[1]!;
    expect(repair.previous?.diagnostics.length).toBeGreaterThan(0);
    expect(repair.previous?.diagnostics.length).toBeLessThanOrEqual(25);
    expect(repair.previous?.candidateText.length).toBeLessThanOrEqual(60_000);
    expect(repair.previous?.diagnostics[0]?.message).toContain('s-missing');
    expect(provider.requests[0]!.previous).toBeUndefined();
  });

  it('never makes a third request when the repair is still invalid', async () => {
    const provider = new ScriptedDraftProvider([
      { candidate: invalidText() },
      { candidate: invalidText() },
      { candidate: validText() },
    ]);
    const result = only(await run(provider), 'REJECTED');
    expect(result.repair).toBe('attempted');
    expect(result.stage).toBe('definition');
    expect(provider.requests).toHaveLength(2);
    expect(result).not.toHaveProperty('scenario');
  });

  it('does not repair when the call budget is already spent', async () => {
    const provider = new ScriptedDraftProvider([
      { candidate: invalidText(), httpAttempts: 2 },
      { candidate: validText() },
    ]);
    const result = only(await run(provider), 'REJECTED');
    expect(result.repair).toBe('skipped_budget_exhausted');
    expect(provider.requests).toHaveLength(1);
  });

  it('stops when a provider reports more HTTP attempts than the budget allows', async () => {
    const provider = new ScriptedDraftProvider([{ candidate: validText(), httpAttempts: 3 }]);
    const result = only(await run(provider), 'STOPPED');
    expect(result.reason).toBe('CALL_BUDGET_EXCEEDED');
  });

  it('stops (without accepting anything) when the repair request itself fails', async () => {
    const provider = new ScriptedDraftProvider([{ candidate: invalidText() }, { fail: 'refusal' }]);
    const result = only(await run(provider), 'STOPPED');
    expect(result.phase).toBe('repair');
    expect(result.reason).toBe('REFUSAL');
    expect(result.priorDiagnostics.length).toBeGreaterThan(0);
  });
});

describe('provider failures stop the run and never trigger content repair', () => {
  const cases: Array<[DraftFailureKind, StopReason]> = [
    ['refusal', 'REFUSAL'],
    ['truncated', 'TRUNCATED'],
    ['authentication', 'AUTHENTICATION'],
    ['rate_limit', 'RATE_LIMITED'],
    ['timeout', 'TIMEOUT'],
    ['network', 'NETWORK'],
    ['cancelled', 'CANCELLED'],
    ['provider_error', 'PROVIDER_ERROR'],
    ['invalid_response', 'INVALID_RESPONSE'],
  ];
  it.each(cases)('%s -> %s after exactly one request', async (kind, reason) => {
    const provider = new ScriptedDraftProvider([{ fail: kind }, { candidate: validText() }]);
    const result = only(await run(provider), 'STOPPED');
    expect(result.reason).toBe(reason);
    expect(result.phase).toBe('generate');
    expect(provider.requests).toHaveLength(1);
    expect(result.provenance.requests).toHaveLength(1);
    expect(result.provenance.requests[0]!.outcome).toBe(reason);
    expect(result.provenance.candidateHash).toBeNull();
  });

  it('treats an unexpected provider exception as a stable PROVIDER_ERROR without its message', async () => {
    const provider = new ScriptedDraftProvider([]);
    const result = only(await run(provider), 'STOPPED');
    expect(result.reason).toBe('PROVIDER_ERROR');
    expect(JSON.stringify(result)).not.toContain('script exhausted');
  });

  it('stops with DEADLINE_EXCEEDED when the overall deadline passes', async () => {
    const provider = new ScriptedDraftProvider([{ hang: true }, { candidate: validText() }]);
    const result = only(
      await run(provider, {
        limits: { maxOutputTokens: 1000, requestTimeoutMs: 60_000, deadlineMs: 30 },
      }),
      'STOPPED',
    );
    expect(result.reason).toBe('DEADLINE_EXCEEDED');
    expect(provider.requests).toHaveLength(1);
  });

  it('clamps the per-request timeout to the remaining deadline', async () => {
    const provider = new ScriptedDraftProvider([{ candidate: validText() }]);
    await run(provider, {
      limits: { maxOutputTokens: 1000, requestTimeoutMs: 60_000, deadlineMs: 5_000 },
    });
    expect(provider.requests[0]!.timeoutMs).toBeLessThanOrEqual(5_000);
    expect(provider.requests[0]!.maxOutputTokens).toBe(1000);
  });

  it('stops with CANCELLED on external cancellation', async () => {
    const controller = new AbortController();
    const provider = new ScriptedDraftProvider([{ hang: true }]);
    const pending = run(provider, { signal: controller.signal });
    setTimeout(() => controller.abort(), 10);
    const result = only(await pending, 'STOPPED');
    expect(result.reason).toBe('CANCELLED');
    expect(provider.requests).toHaveLength(1);
  });

  it('does not start any request when already cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    const provider = new ScriptedDraftProvider([{ candidate: validText() }]);
    const result = only(await run(provider, { signal: controller.signal }), 'STOPPED');
    expect(result.reason).toBe('CANCELLED');
    expect(provider.requests).toHaveLength(0);
  });
});
