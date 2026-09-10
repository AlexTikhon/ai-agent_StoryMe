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
      dimensions: {
        structuralValidity: true,
        personalization: true,
        protagonistConsistency: true,
        ageAppropriateness: true,
        continuity: true,
        repetitionAcceptable: true,
        pageProgression: true,
        endingQuality: true,
      },
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

  it('detects the wrong page count as structural failure', async () => {
    const { input, result } = await candidate();
    result.bookPreview.pages.pop();
    result.storyPlan.pages.pop();
    const report = evaluateStoryQuality(result, input);
    expect(report.dimensions.structuralValidity).toBe(false);
    expect(report.issues).toContainEqual(expect.objectContaining({ code: 'page_count_mismatch' }));
  });

  it('detects when the personalized protagonist disappears', async () => {
    const { input, result } = await candidate();
    for (const page of result.bookPreview.pages) page.text = page.text.replaceAll('Mia', 'Riley');
    for (const page of result.storyPlan.pages) {
      page.storyText = page.storyText.replaceAll('Mia', 'Riley');
    }
    const report = evaluateStoryQuality(result, input);
    expect(report.dimensions.protagonistConsistency).toBe(false);
    expect(report.issues).toContainEqual(
      expect.objectContaining({ code: 'child_name_missing_from_story' }),
    );
  });

  it('accepts natural name/theme/age personalization without requiring metadata dumping', async () => {
    const { input, result } = await candidate();
    const report = evaluateStoryQuality(result, input);
    expect(report.dimensions.personalization).toBe(true);
    expect(report.issues).not.toContainEqual(
      expect.objectContaining({ code: 'personalization_insufficient' }),
    );
  });

  it('accepts a distinct resolved ending and rejects an empty ending', async () => {
    const { input, result } = await candidate();
    expect(evaluateStoryQuality(result, input).dimensions.endingQuality).toBe(true);

    result.storyPlan.resolution = '';
    result.bookPreview.pages.at(-1)!.text = '';
    result.storyPlan.pages.at(-1)!.storyText = '';
    const broken = evaluateStoryQuality(result, input);
    expect(broken.dimensions.endingQuality).toBe(false);
    expect(broken.issues).toContainEqual(expect.objectContaining({ code: 'ending_missing' }));
  });

  it('detects conservative near-duplicate narration', async () => {
    const { input, result } = await candidate();
    const first = 'Mia found a silver key beside the quiet green gate and carefully held it up.';
    const second = 'Mia found a silver key beside the quiet green gate and carefully lifted it up.';
    result.bookPreview.pages[0]!.text = first;
    result.storyPlan.pages[0]!.storyText = first;
    result.bookPreview.pages[1]!.text = second;
    result.storyPlan.pages[1]!.storyText = second;
    const report = evaluateStoryQuality(result, input);
    expect(report.dimensions.repetitionAcceptable).toBe(false);
    expect(report.issues).toContainEqual(
      expect.objectContaining({ code: 'near_duplicate_page_text', pageNumber: 2 }),
    );
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
