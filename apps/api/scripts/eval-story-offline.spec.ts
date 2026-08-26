import { describe, expect, it } from 'vitest';
import { runOfflineStoryEvaluation } from './eval-story-offline';
import {
  MALFORMED_STORY_FIXTURES,
  OFFLINE_STORY_FIXTURES,
} from './story-quality-evaluation.fixtures';

describe('offline story quality evaluation', () => {
  it('accepts all representative good fixtures', async () => {
    const results = await runOfflineStoryEvaluation();
    const good = results.filter((result) => result.kind === 'good');
    expect(good).toHaveLength(OFFLINE_STORY_FIXTURES.length);
    expect(good.every((result) => result.passed)).toBe(true);
  });

  it('rejects every malformed fixture for its intended reason', async () => {
    const results = await runOfflineStoryEvaluation();
    const malformed = results.filter((result) => result.kind === 'malformed');
    expect(malformed).toHaveLength(MALFORMED_STORY_FIXTURES.length);
    expect(malformed.every((result) => result.passed)).toBe(true);
  });
});
