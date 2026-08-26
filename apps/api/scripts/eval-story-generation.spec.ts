import { describe, expect, it } from 'vitest';
import { MockStoryGenerationProvider } from '../src/agent/mock-story-generation-provider';
import {
  evaluateStoryCases,
  renderStoryEvalComparison,
  STORY_EVAL_CASES,
} from './eval-story-generation';

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

  it('renders a compact baseline comparison without a subjective score', async () => {
    const baseline = await evaluateStoryCases(
      new MockStoryGenerationProvider(),
      STORY_EVAL_CASES.slice(0, 2),
    );
    const report = renderStoryEvalComparison(baseline, baseline, {
      baseline: 'story-v2',
      candidate: 'story-v3',
    });
    expect(report).toContain('| valid generations | 2/2 | 2/2 |');
    expect(report).toContain('story-v2');
    expect(report).toContain('story-v3');
    expect(report).not.toMatch(/subjective score:\s*\d/iu);
  });
});
