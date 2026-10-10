import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildAuthoringEvalCases,
  evaluateAuthoringCases,
  exitCodeFor,
  runAuthoringOfflineEvaluation,
  type AuthoringEvalCase,
} from './eval-interactive-authoring-offline';

afterEach(() => vi.unstubAllGlobals());

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
