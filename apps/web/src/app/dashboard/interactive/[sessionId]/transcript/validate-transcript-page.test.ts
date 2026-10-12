import { describe, it, expect } from 'vitest';
import type { InteractiveTranscriptDto } from '@book/types';
import {
  SESSION_ID,
  makeTranscriptPage,
  makeTranscriptStep,
} from '../../interactive-test-fixtures';
import { checkTranscriptPage, type TranscriptPageExpectation } from './validate-transcript-page';

const IDENTITY = { scenarioId: 'warsaw-last-delivery', scenarioVersion: 1, completedRevision: 6 };

function expectation(
  overrides: Partial<TranscriptPageExpectation> = {},
): TranscriptPageExpectation {
  return {
    sessionId: SESSION_ID,
    limit: 3,
    nextRevision: 0,
    identity: null,
    requestedCursor: null,
    usedCursors: new Set(),
    ...overrides,
  };
}

/** Page 2 of a 7-revision story, as it would be requested after revisions 0-2. */
const second = (overrides: Partial<InteractiveTranscriptDto> = {}) =>
  makeTranscriptPage(3, 5, 6, overrides);
const secondExpectation = (overrides: Partial<TranscriptPageExpectation> = {}) =>
  expectation({
    nextRevision: 3,
    identity: IDENTITY,
    requestedCursor: 'cursor-3',
    usedCursors: new Set(),
    ...overrides,
  });

describe('checkTranscriptPage', () => {
  it('accepts a first page, a middle page and the final page', () => {
    expect(checkTranscriptPage(makeTranscriptPage(0, 2, 6), expectation()).ok).toBe(true);
    expect(checkTranscriptPage(second(), secondExpectation()).ok).toBe(true);
    const last = makeTranscriptPage(6, 6, 6);
    expect(
      checkTranscriptPage(last, secondExpectation({ nextRevision: 6, requestedCursor: 'cursor-6' }))
        .ok,
    ).toBe(true);
  });

  it('accepts a story that ends on its first page', () => {
    const only = makeTranscriptPage(0, 1, 1);
    expect(checkTranscriptPage(only, expectation()).ok).toBe(true);
  });

  it.each([
    ['null', null],
    ['an array', []],
    ['a string', 'x'],
  ])('rejects %s', (_label, value) => {
    expect(checkTranscriptPage(value, expectation()).ok).toBe(false);
  });

  it.each<[string, (page: InteractiveTranscriptDto) => unknown]>([
    ['another session', (p) => ({ ...p, sessionId: 'other' })],
    ['an empty scenario id', (p) => ({ ...p, scenarioId: '' })],
    ['a fractional scenario version', (p) => ({ ...p, scenarioVersion: 1.5 })],
    ['a negative completed revision', (p) => ({ ...p, completedRevision: -1 })],
    ['no steps', (p) => ({ ...p, steps: [] })],
    ['non-array steps', (p) => ({ ...p, steps: 'x' })],
    ['more steps than requested', (p) => ({ ...p, steps: [...p.steps, makeTranscriptStep(3, 6)] })],
    [
      'a malformed step',
      (p) => ({ ...p, steps: [{ ...p.steps[0], narration: 7 }, ...p.steps.slice(1)] }),
    ],
    [
      'a missing scene',
      (p) => ({ ...p, steps: [{ ...p.steps[0], scene: null }, ...p.steps.slice(1)] }),
    ],
    [
      'a malformed ending',
      (p) => ({ ...p, steps: [{ ...p.steps[0], ending: { title: 1 } }, ...p.steps.slice(1)] }),
    ],
    ['a step that skips a revision', (p) => ({ ...p, steps: [p.steps[0], p.steps[2]] })],
    ['a repeated step', (p) => ({ ...p, steps: [p.steps[0], p.steps[0]] })],
    ['reordered steps', (p) => ({ ...p, steps: [p.steps[1], p.steps[0], p.steps[2]] })],
    [
      'a first step labelled as arrived by a choice',
      (p) => ({ ...p, steps: [{ ...p.steps[0], arrivedByChoiceLabel: 'x' }, ...p.steps.slice(1)] }),
    ],
    [
      'a later step with no arrival label',
      (p) => ({ ...p, steps: [p.steps[0], { ...p.steps[1], arrivedByChoiceLabel: null }] }),
    ],
    [
      'an ending before the completed revision',
      (p) => ({
        ...p,
        steps: [{ ...p.steps[0], ending: { title: 't', summary: 's' } }, ...p.steps.slice(1)],
      }),
    ],
    ['an offered cursor that is empty', (p) => ({ ...p, nextCursor: '' })],
    ['a missing next cursor on an unfinished history', (p) => ({ ...p, nextCursor: null })],
  ])('rejects a first page with %s', (_label, mutate) => {
    expect(checkTranscriptPage(mutate(makeTranscriptPage(0, 2, 6)), expectation()).ok).toBe(false);
  });

  it('rejects a first page that does not start at revision 0', () => {
    expect(checkTranscriptPage(makeTranscriptPage(1, 3, 6), expectation()).ok).toBe(false);
  });

  it('rejects the final page when it still offers a next page', () => {
    const last = makeTranscriptPage(6, 6, 6, { nextCursor: 'more' });
    expect(checkTranscriptPage(last, secondExpectation({ nextRevision: 6 })).ok).toBe(false);
  });

  it('rejects a final step without its ending, and a step past the completed revision', () => {
    const noEnding = makeTranscriptPage(6, 6, 6);
    noEnding.steps = [{ ...noEnding.steps[0]!, ending: null }];
    expect(checkTranscriptPage(noEnding, secondExpectation({ nextRevision: 6 })).ok).toBe(false);

    const beyond = makeTranscriptPage(5, 7, 6);
    expect(checkTranscriptPage(beyond, secondExpectation({ nextRevision: 5 })).ok).toBe(false);
  });

  describe('against the history already shown', () => {
    it.each<[string, Partial<InteractiveTranscriptDto>]>([
      ['another scenario', { scenarioId: 'other-story' }],
      ['another scenario version', { scenarioVersion: 2 }],
      ['another completed revision', { completedRevision: 7 }],
      ['another session', { sessionId: '00000000-0000-4000-8000-000000000009' }],
    ])('rejects a page for %s', (_label, overrides) => {
      expect(checkTranscriptPage(second(overrides), secondExpectation()).ok).toBe(false);
    });

    it('rejects a page that repeats already shown revisions', () => {
      expect(checkTranscriptPage(makeTranscriptPage(2, 4, 6), secondExpectation()).ok).toBe(false);
    });

    it('rejects a page that skips ahead', () => {
      expect(checkTranscriptPage(makeTranscriptPage(4, 6, 6), secondExpectation()).ok).toBe(false);
    });

    it('rejects a next cursor equal to the cursor just used, or to any used before', () => {
      expect(checkTranscriptPage(second({ nextCursor: 'cursor-3' }), secondExpectation()).ok).toBe(
        false,
      );
      expect(
        checkTranscriptPage(
          second({ nextCursor: 'cursor-0' }),
          secondExpectation({ usedCursors: new Set(['cursor-0']) }),
        ).ok,
      ).toBe(false);
    });
  });

  it('returns only the allow-listed fields of the page', () => {
    const page = { ...makeTranscriptPage(0, 2, 6), extra: 'x' };
    const checked = checkTranscriptPage(page, expectation());
    expect(checked.ok && 'extra' in checked.page).toBe(false);
  });
});
