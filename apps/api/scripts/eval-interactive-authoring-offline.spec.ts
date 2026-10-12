import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildAuthoringEvalCases,
  evaluateAuthoringCases,
  exitCodeFor,
  runAuthoringOfflineEvaluation,
  type AuthoringEvalCase,
} from './eval-interactive-authoring-offline';

afterEach(() => vi.unstubAllGlobals());

/** Every case id that existed before the corpus was added, in its original order. */
const RETAINED_CASE_IDS = [
  'valid.candidate.original-episode',
  'valid.routes.both-endings',
  'valid.pipeline.mock-run',
  'valid.pipeline.mock-repeat-hash',
  'valid.repair.single-repair',
  'valid.registry.not-published',
  'adv.format.malformed-json',
  'adv.format.unknown-field',
  'adv.format.unknown-effect',
  'adv.format.duplicate-entry',
  'adv.identity.changed-id',
  'adv.identity.changed-version',
  'adv.identity.published-collision',
  'adv.definition.duplicate-id',
  'adv.definition.unresolved-reference',
  'adv.constraints.decision-points',
  'adv.constraints.cyclic-graph',
  'adv.analysis.unreachable-ending',
  'adv.analysis.unusable-choice',
  'adv.analysis.dead-end',
  'adv.analysis.speaker-knowledge',
  'adv.witness.oversized-narration',
  'adv.repair.still-invalid',
  'adv.provider.refusal',
  'adv.provider.truncated',
  'adv.provider.authentication',
  'adv.provider.timeout',
  'adv.provider.network',
  'adv.provider.cancellation',
  'adv.budget.exhausted',
  'adv.budget.provider-overrun',
  'adv.transport.no-http-retry',
  'adv.transport.no-network-retry',
  'adv.transport.no-timeout-retry',
  'adv.review.mechanical-not-approved',
] as const;

/** New corpus cases and the single stable outcome each must produce. */
const CORPUS_CASES: Record<string, string> = {
  'valid.corpus.harbour-first-pass': 'REVIEW_REQUIRED:repaired=false:calls=1:routes=6',
  'valid.corpus.harbour-repair': 'REVIEW_REQUIRED:repaired=true:calls=2:routes=6',
  'adv.corpus.harbour-wrong-brief': 'REJECTED:identity:repair=attempted:calls=2',
  'valid.corpus.blackout-first-pass': 'REVIEW_REQUIRED:repaired=false:calls=1:routes=6',
  'valid.corpus.blackout-repair': 'REVIEW_REQUIRED:repaired=true:calls=2:routes=6',
  'adv.corpus.blackout-wrong-brief': 'REJECTED:identity:repair=attempted:calls=2',
  'valid.corpus.not-published': 'ACCEPTED',
};

describe('offline interactive authoring evaluation', () => {
  it('produces only expected outcomes for every valid and adversarial case', async () => {
    const results = await runAuthoringOfflineEvaluation();
    expect(results.filter((r) => !r.passed)).toEqual([]);
    expect(exitCodeFor(results)).toBe(0);
  });

  it('covers the required fixture families with unique stable ids', () => {
    const cases = buildAuthoringEvalCases();
    const ids = cases.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every((id) => /^(valid|adv)\.[a-z-]+\.[a-z-]+$/.test(id))).toBe(true);
    expect(cases.filter((c) => c.kind === 'valid').length).toBeGreaterThanOrEqual(5);
    expect(cases.filter((c) => c.kind === 'adversarial').length).toBeGreaterThanOrEqual(25);
    for (const required of [
      'valid.routes.both-endings',
      'valid.pipeline.mock-repeat-hash',
      'valid.repair.single-repair',
      'adv.format.malformed-json',
      'adv.format.unknown-field',
      'adv.format.unknown-effect',
      'adv.definition.duplicate-id',
      'adv.definition.unresolved-reference',
      'adv.analysis.unreachable-ending',
      'adv.analysis.unusable-choice',
      'adv.analysis.dead-end',
      'adv.analysis.speaker-knowledge',
      'adv.constraints.cyclic-graph',
      'adv.repair.still-invalid',
      'adv.provider.refusal',
      'adv.provider.truncated',
      'adv.provider.cancellation',
      'adv.budget.exhausted',
      'adv.transport.no-http-retry',
      'adv.identity.published-collision',
      'adv.review.mechanical-not-approved',
    ]) {
      expect(ids).toContain(required);
    }
  });

  it('retains every pre-corpus case under its original stable id', () => {
    const ids = buildAuthoringEvalCases().map((c) => c.id);
    for (const retained of RETAINED_CASE_IDS) expect(ids).toContain(retained);
    expect(RETAINED_CASE_IDS).toHaveLength(35);
    // Corpus cases are appended, so the original cases keep their position and order.
    expect(ids.slice(0, RETAINED_CASE_IDS.length)).toEqual([...RETAINED_CASE_IDS]);
  });

  it('adds first-pass, repair and wrong-brief cases for each new corpus fixture', async () => {
    const results = await runAuthoringOfflineEvaluation();
    const byId = new Map(results.map((r) => [r.id, r]));
    for (const [id, expected] of Object.entries(CORPUS_CASES)) {
      const result = byId.get(id);
      expect(result, id).toBeDefined();
      expect(result!.expected).toBe(expected);
      expect(result!.actual).toBe(expected);
      expect(result!.passed).toBe(true);
    }
    for (const [id, kind] of [
      ['valid.corpus.harbour-first-pass', 'valid'],
      ['valid.corpus.harbour-repair', 'valid'],
      ['adv.corpus.harbour-wrong-brief', 'adversarial'],
      ['valid.corpus.blackout-first-pass', 'valid'],
      ['valid.corpus.blackout-repair', 'valid'],
      ['adv.corpus.blackout-wrong-brief', 'adversarial'],
    ] as const) {
      expect(byId.get(id)!.kind).toBe(kind);
    }
    // Last Tram stays covered by the original cases; no duplicate corpus case for it.
    expect(results.some((r) => r.id.includes('last-tram'))).toBe(false);
  });

  it('is deterministic across runs', async () => {
    expect(await runAuthoringOfflineEvaluation()).toEqual(await runAuthoringOfflineEvaluation());
  });

  it('needs no network: the global fetch is never touched', async () => {
    const fetchSpy = vi.fn(() => {
      throw new Error('network access attempted');
    });
    vi.stubGlobal('fetch', fetchSpy);
    const results = await runAuthoringOfflineEvaluation();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(exitCodeFor(results)).toBe(0);
  });

  it('fails the run when an outcome is unexpected or a case throws', async () => {
    const wrong: AuthoringEvalCase = {
      id: 'adv.selftest.wrong-expectation',
      kind: 'adversarial',
      expected: 'REJECTED:definition',
      run: () => 'REVIEW_REQUIRED',
    };
    const boom: AuthoringEvalCase = {
      id: 'adv.selftest.throws',
      kind: 'adversarial',
      expected: 'REJECTED:definition',
      run: () => {
        throw new Error('secret detail');
      },
    };
    const results = await evaluateAuthoringCases([...buildAuthoringEvalCases(), wrong, boom]);
    expect(results.filter((r) => !r.passed).map((r) => r.id)).toEqual([wrong.id, boom.id]);
    expect(results.find((r) => r.id === boom.id)!.actual).toBe('UNEXPECTED:Error');
    expect(exitCodeFor(results)).toBe(1);
    expect(exitCodeFor([])).toBe(1);
  });
});
