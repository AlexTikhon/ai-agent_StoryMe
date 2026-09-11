import { MockCharacterProfileProvider } from './character-profile-provider';
import { describe, expect, it } from 'vitest';
import { detectStoryLanguage, resolveLesson } from './story-language';
import { MockStoryGenerationProvider } from './story-generation-provider';
import { evaluateStoryQuality } from './story-quality-gate';

describe('prose language and localized lessons', () => {
  it('fails English prose with Russian metadata', async () => {
    const input = {
      bookId: 'language-test',
      childName: 'Mia',
      childAge: 6,
      language: 'en',
      theme: 'friendship',
      pageCount: 4,
    };
    const story = await new MockStoryGenerationProvider().generateStory({
      ...input,
      characterProfile: await new MockCharacterProfileProvider().buildProfile(input),
    });
    story.bookPreview.metadata.language = 'ru';
    expect(evaluateStoryQuality(story, { ...input, language: 'ru' }).issues).toContainEqual(
      expect.objectContaining({ code: 'actual_language_mismatch', severity: 'error' }),
    );
  });
  it.each(['ru', 'pl'] as const)(
    'accepts a natural predefined lesson translation in %s',
    async (language) => {
      const input = {
        bookId: 'lesson-test',
        childName: language === 'ru' ? 'Маша' : 'Zofia',
        childAge: 5,
        language,
        theme: 'friendship',
        pageCount: 4,
        educationalMessage: 'Sharing is caring',
      };
      const story = await new MockStoryGenerationProvider().generateStory({
        ...input,
        characterProfile: await new MockCharacterProfileProvider().buildProfile(input),
      });
      story.storyPlan.educationalMessage =
        language === 'ru' ? 'Делиться — значит заботиться' : 'Dzielenie się jest wyrazem troski';
      expect(
        evaluateStoryQuality(story, input).issues.some(
          (issue) => issue.code === 'educational_message_mismatch',
        ),
      ).toBe(false);
    },
  );
  it('retains free-text intent and does not claim certainty for a short sample', () => {
    expect(resolveLesson('Be gentle with the new puppy')).toMatchObject({ kind: 'free_text' });
    expect(detectStoryLanguage('Mia i Ola')).toBe('unknown');
  });
});
