import { describe, expect, it } from 'vitest';
import { MockCharacterProfileProvider } from './character-profile-provider';
import { MockStoryGenerationProvider } from './story-generation-provider';
import { evaluateStoryQuality, maximumWordsPerPage } from './story-quality-gate';

async function candidate(overrides: { childAge?: number; language?: string } = {}) {
  const childAge = overrides.childAge ?? 7;
  const language = overrides.language ?? 'en';
  const input = {
    bookId: 'book-1',
    childName: 'Mia',
    childAge,
    theme: 'forest',
    language,
    pageCount: 6,
  };
  const profile = await new MockCharacterProfileProvider().buildProfile(input);
  const result = await new MockStoryGenerationProvider().generateStory({
    ...input,
    characterProfile: profile,
  });
  return { input, result };
}

describe('evaluateStoryQuality', () => {
  it('passes a normal deterministic provider result without changing it', async () => {
    const { input, result } = await candidate();

    expect(evaluateStoryQuality(result, input)).toEqual({
      version: 1,
      overallPassed: true,
      issues: [],
      flaggedPages: [],
    });
  });

  it('returns privacy-safe typed findings for cross-artifact drift', async () => {
    const { input, result } = await candidate();
    result.bookPreview.pages[0]!.text = 'Different private candidate text';

    const report = evaluateStoryQuality(result, input);

    expect(report.overallPassed).toBe(false);
    expect(report.issues).toContainEqual({
      code: 'page_text_mismatch',
      category: 'consistency',
      severity: 'error',
      repairable: true,
      pageNumber: 1,
      message: 'The story plan and preview disagree about a page text.',
    });
    expect(JSON.stringify(report)).not.toContain('Different private candidate text');
  });

  it('flags duplicate pages and records only the later page number', async () => {
    const { input, result } = await candidate();
    result.bookPreview.pages[1]!.text = result.bookPreview.pages[0]!.text;
    result.storyPlan.pages[1]!.storyText = result.storyPlan.pages[0]!.storyText;

    const report = evaluateStoryQuality(result, input);

    expect(report.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'duplicate_page_text', pageNumber: 2 }),
      ]),
    );
    expect(report.flaggedPages).toContain(2);
  });

  it('uses explicit age-banded page limits', () => {
    expect(maximumWordsPerPage(4)).toBe(90);
    expect(maximumWordsPerPage(7)).toBe(130);
    expect(maximumWordsPerPage(9)).toBe(170);
    expect(maximumWordsPerPage(12)).toBe(220);
  });

  it('rejects markup, URLs, and control characters without echoing content', async () => {
    const { input, result } = await candidate();
    result.bookPreview.pages[0]!.learningGoal = '<script>bad</script>';
    result.bookPreview.pages[1]!.title = 'See https://example.test';
    result.bookPreview.pages[2]!.text += '\u0007';
    result.storyPlan.pages[2]!.storyText += '\u0007';

    const report = evaluateStoryQuality(result, input);

    expect(report.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'unexpected_markup_or_url',
          pageNumber: 1,
          repairable: false,
        }),
        expect.objectContaining({
          code: 'unexpected_markup_or_url',
          pageNumber: 2,
          repairable: false,
        }),
        expect.objectContaining({
          code: 'unsafe_control_characters',
          pageNumber: 3,
          repairable: false,
        }),
      ]),
    );
    expect(JSON.stringify(report)).not.toContain('example.test');
  });
});
