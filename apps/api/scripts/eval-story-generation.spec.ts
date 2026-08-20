import { describe, expect, it } from 'vitest';
import { MockStoryGenerationProvider } from '../src/agent/mock-story-generation-provider';
import { evaluateStoryCases, STORY_EVAL_CASES } from './eval-story-generation';

describe('story generation evaluator', () => {
  it('passes the deterministic synthetic suite without paid calls or identity leaks', async () => {
    const cases = STORY_EVAL_CASES.slice(0, 3);
    const first = await evaluateStoryCases(new MockStoryGenerationProvider(), cases);
    const second = await evaluateStoryCases(new MockStoryGenerationProvider(), cases);

    expect(first).toHaveLength(3);
    expect(first.every((result) => result.passed)).toBe(true);
    expect(first.every((result) => result.provider === 'mock')).toBe(true);
    expect(first.every((result) => result.characterConsistencyPassed)).toBe(true);
    expect(first.map(({ durationMs: _duration, ...result }) => result)).toEqual(
      second.map(({ durationMs: _duration, ...result }) => result),
    );
  });
});
