import { describe, expect, it } from 'vitest';
import { CHARACTER_RESPONSE_FORMAT, STORY_RESPONSE_FORMAT } from '../common/structured-output';
import { PROMPT_SPECS } from './prompt-specs';

describe('PromptSpec contracts', () => {
  it('uses the exact outbound structured schemas as the versioned contracts', () => {
    expect(PROMPT_SPECS.characterProfile.outputSchema).toBe(CHARACTER_RESPONSE_FORMAT);
    expect(PROMPT_SPECS.story.outputSchema).toBe(STORY_RESPONSE_FORMAT);
    expect(PROMPT_SPECS.storyRepair.outputSchema).toBe(STORY_RESPONSE_FORMAT);
  });

  it('authorizes only one bounded repair and no implicit evaluator calls', () => {
    expect(PROMPT_SPECS.story.repair).toEqual({ allowed: false, maximumCalls: 0 });
    expect(PROMPT_SPECS.storyRepair.repair).toEqual({ allowed: true, maximumCalls: 1 });
    expect(Object.keys(PROMPT_SPECS)).not.toContain('qualityEvaluator');
  });
});
