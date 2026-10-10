import { describe, expect, it } from 'vitest';
import {
  buildInteractiveEvalCases,
  evaluateInteractiveCases,
  exitCodeFor,
  runInteractiveOfflineEvaluation,
  type InteractiveEvalCase,
} from './eval-interactive-offline';

describe('offline interactive engine evaluation', () => {
  it('produces only expected outcomes for every valid and adversarial case', () => {
    const results = runInteractiveOfflineEvaluation();
    expect(results.filter((r) => !r.passed)).toEqual([]);
    expect(exitCodeFor(results)).toBe(0);
  });

  it('covers both valid and adversarial cases with unique stable ids', () => {
    const cases = buildInteractiveEvalCases();
    const ids = cases.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every((id) => /^(valid|adv)\.[a-z-]+\.[a-z-]+$/.test(id))).toBe(true);
    expect(cases.filter((c) => c.kind === 'valid').length).toBeGreaterThanOrEqual(4);
    expect(cases.filter((c) => c.kind === 'adversarial').length).toBeGreaterThanOrEqual(20);
    // Offline replay covers duplicate-event rejection; HTTP duplicates are an integration concern.
    expect(ids).toContain('adv.replay.duplicate-event');
  });

  it('is deterministic across runs', () => {
    expect(runInteractiveOfflineEvaluation()).toEqual(runInteractiveOfflineEvaluation());
  });

  it('fails the run when an outcome is unexpected', () => {
    const wrong: InteractiveEvalCase = {
      id: 'adv.selftest.wrong-expectation',
      kind: 'adversarial',
      expected: 'SESSION_TERMINAL',
      run: () => 'ACCEPTED',
    };
    const results = evaluateInteractiveCases([...buildInteractiveEvalCases(), wrong]);
    expect(results.filter((r) => !r.passed).map((r) => r.id)).toEqual([wrong.id]);
    expect(exitCodeFor(results)).toBe(1);
  });

  it('reports an unexpected exception as a failure rather than crashing', () => {
    const boom: InteractiveEvalCase = {
      id: 'adv.selftest.throws',
      kind: 'adversarial',
      expected: 'UNKNOWN_CHOICE',
      run: () => {
        throw new Error('boom');
      },
    };
    const [result] = evaluateInteractiveCases([boom]);
    expect(result).toMatchObject({ passed: false, actual: 'UNEXPECTED:Error: boom' });
  });

  it('treats an empty evaluation as a failure', () => {
    expect(exitCodeFor([])).toBe(1);
  });
});
