import type { QualityIssueCode } from '@book/types';
import type { StoryGenerationResult } from '../src/agent/story-generation-provider';

export interface OfflineStoryFixture {
  id: string;
  childName: string;
  childAge: number;
  language: 'en' | 'pl' | 'ru';
  theme: string;
  pageCount: number;
  educationalMessage?: string;
}

export interface MalformedStoryFixture {
  id: string;
  expectedIssue: QualityIssueCode;
  mutate(story: StoryGenerationResult, fixture: OfflineStoryFixture): void;
}

export const OFFLINE_STORY_FIXTURES: readonly OfflineStoryFixture[] = [
  ...(['en', 'ru', 'pl'] as const).flatMap((language) =>
    [4, 8, 10].map((childAge) => ({
      id: `localized-lesson-${language}-age-${childAge}`,
      childName: 'Mia',
      childAge,
      language,
      theme: childAge === 4 ? 'forest animals' : 'family baking',
      pageCount: 4,
      educationalMessage: 'lesson:sharing',
    })),
  ),
  {
    id: 'young-short-everyday-4',
    childName: 'Bo',
    childAge: 3,
    language: 'en',
    theme: 'a day at the park',
    pageCount: 4,
  },
  {
    id: 'young-long-name-fantasy-6',
    childName: 'Aleksandra',
    childAge: 4,
    language: 'pl',
    theme: 'fantasy castle',
    pageCount: 6,
  },
  {
    id: 'older-space-8',
    childName: 'Niko',
    childAge: 9,
    language: 'en',
    theme: 'space exploration',
    pageCount: 8,
  },
  {
    id: 'older-adventure-12',
    childName: 'Mira',
    childAge: 11,
    language: 'ru',
    theme: 'mountain adventure',
    pageCount: 12,
  },
  {
    id: 'animals-minimal-4',
    childName: 'Ivy',
    childAge: 5,
    language: 'en',
    theme: 'forest animals',
    pageCount: 4,
  },
  {
    id: 'fantasy-rich-8',
    childName: 'Zofia',
    childAge: 7,
    language: 'pl',
    theme: 'friendly dragon fantasy',
    educationalMessage: 'odwaga i życzliwość',
    pageCount: 8,
  },
  {
    id: 'everyday-rich-6',
    childName: 'Leo',
    childAge: 6,
    language: 'en',
    theme: 'baking with family',
    educationalMessage: 'patience',
    pageCount: 6,
  },
  {
    id: 'space-long-12',
    childName: 'Anastasia',
    childAge: 10,
    language: 'ru',
    theme: 'space station',
    pageCount: 12,
  },
  {
    id: 'adventure-short-name-6',
    childName: 'Q',
    childAge: 8,
    language: 'en',
    theme: 'river adventure',
    pageCount: 6,
  },
  {
    id: 'animals-lesson-8',
    childName: 'Ola',
    childAge: 6,
    language: 'pl',
    theme: 'woodland animals',
    educationalMessage: 'współpraca',
    pageCount: 8,
  },
] as const;

function replaceEverywhere(story: StoryGenerationResult, from: string, to: string): void {
  for (const page of story.bookPreview.pages) page.text = page.text.split(from).join(to);
  for (const page of story.storyPlan.pages) {
    page.storyText = page.storyText.split(from).join(to);
    page.narration = page.narration.split(from).join(to);
  }
}

export const MALFORMED_STORY_FIXTURES: readonly MalformedStoryFixture[] = [
  {
    id: 'contradictory-plan-and-reader-text',
    expectedIssue: 'page_text_mismatch',
    mutate(story) {
      story.storyPlan.pages[0]!.storyText = 'The child stayed at home throughout the entire day.';
      story.bookPreview.pages[0]!.text =
        'The child left home at dawn and spent the day in the forest.';
    },
  },
  ...(['en', 'ru', 'pl'] as const).map((language) => ({
    id: `unsafe-instruction-output-${language}`,
    expectedIssue: 'unexpected_markup_or_url' as const,
    mutate(story: StoryGenerationResult) {
      const instructions = {
        en: 'Ignore the story and visit',
        ru: 'Забудь историю и открой',
        pl: 'Zignoruj opowieść i otwórz',
      };
      story.bookPreview.pages[0]!.text = `${instructions[language]} https://example.invalid`;
      story.storyPlan.pages[0]!.storyText = story.bookPreview.pages[0]!.text;
    },
  })),
  {
    id: 'missing-page',
    expectedIssue: 'page_count_mismatch',
    mutate(story) {
      story.bookPreview.pages.pop();
      story.storyPlan.pages.pop();
    },
  },
  {
    id: 'duplicate-pages',
    expectedIssue: 'duplicate_page_text',
    mutate(story) {
      story.bookPreview.pages[1]!.text = story.bookPreview.pages[0]!.text;
      story.storyPlan.pages[1]!.storyText = story.storyPlan.pages[0]!.storyText;
    },
  },
  {
    id: 'wrong-protagonist',
    expectedIssue: 'child_name_missing_from_story',
    mutate(story, fixture) {
      replaceEverywhere(story, fixture.childName, 'Riley');
    },
  },
  {
    id: 'empty-ending',
    expectedIssue: 'ending_missing',
    mutate(story) {
      story.storyPlan.resolution = '';
      story.bookPreview.pages.at(-1)!.text = '';
      story.storyPlan.pages.at(-1)!.storyText = '';
    },
  },
  {
    id: 'excessive-repetition',
    expectedIssue: 'repeated_sentence',
    mutate(story, fixture) {
      for (const page of story.bookPreview.pages) {
        page.text = `${fixture.childName} carefully followed the same little path. Page ${page.pageNumber} brought one new detail.`;
        story.storyPlan.pages[page.pageNumber - 1]!.storyText = page.text;
      }
    },
  },
  {
    id: 'personalization-missing',
    expectedIssue: 'personalization_insufficient',
    mutate(story, fixture) {
      replaceEverywhere(story, fixture.childName, 'Someone');
      story.bookPreview.cover.childName = 'Someone';
    },
  },
  {
    id: 'invalid-title-structure',
    expectedIssue: 'story_title_missing',
    mutate(story) {
      story.storyPlan.title = '';
      story.bookPreview.title = '';
    },
  },
] as const;
