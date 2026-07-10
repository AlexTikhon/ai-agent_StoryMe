import { describe, it, expect } from 'vitest';
import type { CharacterProfile } from '@book/types';
import {
  MockStoryGenerationProvider,
  type StoryGenerationInput,
} from './story-generation-provider';

const DEFAULT_CHARACTER_PROFILE: CharacterProfile = {
  childName: 'Mia',
  age: 5,
  visualDescription: 'a cheerful child with a round friendly face',
  faceDescription: 'a round, friendly face with a warm smile',
  hairDescription: 'short wavy brown hair',
  outfitDescription: 'a bright yellow overall with sneakers',
  personalitySummary: 'curious, brave, and kind',
  illustrationStyle: 'warm children book illustration, soft colors, friendly character design',
  consistencyPrompt:
    "Mia, a stylized 5-year-old children's-book character with a round, friendly face with a warm smile, short wavy brown hair, wearing a bright yellow overall with sneakers",
  hasReferencePhoto: false,
  hasCharacterSheet: false,
};

function makeInput(overrides: Partial<StoryGenerationInput> = {}): StoryGenerationInput {
  return {
    bookId: 'b-1',
    childName: 'Mia',
    childAge: 5,
    theme: 'friendship',
    language: 'en',
    characterProfile: DEFAULT_CHARACTER_PROFILE,
    ...overrides,
  };
}

describe('MockStoryGenerationProvider', () => {
  describe('generateStory', () => {
    it('returns the same output for the same input (deterministic)', async () => {
      const provider = new MockStoryGenerationProvider();
      const input = makeInput();

      const first = await provider.generateStory(input);
      const second = await provider.generateStory(input);

      expect(second).toEqual(first);
    });

    it('produces different output for a different bookId, childName, or theme', async () => {
      const provider = new MockStoryGenerationProvider();

      const base = await provider.generateStory(makeInput());
      const differentChild = await provider.generateStory(makeInput({ childName: 'Leo' }));
      const differentTheme = await provider.generateStory(makeInput({ theme: 'courage' }));

      expect(differentChild.characterCard.name).toBe('Leo');
      expect(differentChild.characterCard.name).not.toBe(base.characterCard.name);
      expect(differentTheme.storyPlan.theme).toBe('courage');
      expect(differentTheme.storyPlan.theme).not.toBe(base.storyPlan.theme);
    });

    it('includes a characterCard derived from childName and childAge', async () => {
      const provider = new MockStoryGenerationProvider();

      const result = await provider.generateStory(makeInput({ childName: 'Mia', childAge: 5 }));

      expect(result.characterCard.name).toBe('Mia');
      expect(result.characterCard.age).toBe(5);
      expect(typeof result.characterCard.visualAnchor).toBe('string');
    });

    it('includes a storyPlan with 3 chapters and 2 pages per chapter by default (pageCount omitted)', async () => {
      const provider = new MockStoryGenerationProvider();

      const result = await provider.generateStory(makeInput());

      expect(result.storyPlan.chapters).toHaveLength(3);
      expect(result.storyPlan.pages).toHaveLength(6);
    });

    it('honors a smaller pageCount (Phase 4A)', async () => {
      const provider = new MockStoryGenerationProvider();

      const result = await provider.generateStory(makeInput({ pageCount: 4 }));

      expect(result.storyPlan.pages).toHaveLength(4);
      expect(result.storyPlan.pages.map((p) => p.pageNumber)).toEqual([1, 2, 3, 4]);
    });

    it('honors a larger, odd pageCount by trimming the final chapter to one page (Phase 4A)', async () => {
      const provider = new MockStoryGenerationProvider();

      const result = await provider.generateStory(makeInput({ pageCount: 9 }));

      expect(result.storyPlan.pages).toHaveLength(9);
      expect(result.storyPlan.chapters).toHaveLength(5);
    });

    it('clamps an out-of-range pageCount to [4, 12] (Phase 4A)', async () => {
      const provider = new MockStoryGenerationProvider();

      const tooLow = await provider.generateStory(makeInput({ pageCount: 1 }));
      const tooHigh = await provider.generateStory(makeInput({ pageCount: 100 }));

      expect(tooLow.storyPlan.pages).toHaveLength(4);
      expect(tooHigh.storyPlan.pages).toHaveLength(12);
    });

    it('uses a provided educationalMessage instead of the generated default (Phase 4A)', async () => {
      const provider = new MockStoryGenerationProvider();

      const result = await provider.generateStory(
        makeInput({ educationalMessage: 'It is okay to make mistakes' }),
      );

      expect(result.storyPlan.educationalMessage).toBe('It is okay to make mistakes');
    });

    it('generates a default educationalMessage when none is provided', async () => {
      const provider = new MockStoryGenerationProvider();

      const result = await provider.generateStory(makeInput());

      expect(result.storyPlan.educationalMessage.length).toBeGreaterThan(0);
      expect(result.storyPlan.educationalMessage).toContain('friendship');
    });

    it('every storyPlan page has storyText and an illustration plan', async () => {
      const provider = new MockStoryGenerationProvider();

      const result = await provider.generateStory(makeInput());

      for (const page of result.storyPlan.pages) {
        expect(typeof page.storyText).toBe('string');
        expect(page.storyText.length).toBeGreaterThan(0);
        expect(page.illustration).toBeDefined();
        expect(typeof page.illustration.prompt).toBe('string');
      }
    });

    it('includes a bookPreview with a cover, pages, and back cover', async () => {
      const provider = new MockStoryGenerationProvider();

      const result = await provider.generateStory(makeInput({ childName: 'Mia' }));

      expect(result.bookPreview.cover.childName).toBe('Mia');
      expect(result.bookPreview.pages).toHaveLength(result.storyPlan.pages.length);
      expect(result.bookPreview.backCover.message.length).toBeGreaterThan(0);
    });

    it('includes an imageGenerationResult with one entry per page plus cover and back cover', async () => {
      const provider = new MockStoryGenerationProvider();

      const result = await provider.generateStory(makeInput({ bookId: 'book-42' }));

      expect(result.imageGenerationResult.provider).toBe('local_mock');
      expect(result.imageGenerationResult.images).toHaveLength(result.bookPreview.pages.length + 2);
      for (const image of result.imageGenerationResult.images) {
        expect(image.id.startsWith('book-42')).toBe(true);
      }
    });

    // ── QA: language must be respected (Book Output QA phase) ────────────────

    describe('language handling', () => {
      const CYRILLIC = /[а-яА-ЯёЁ]/;

      it('generates Russian story content when language is "ru"', async () => {
        const provider = new MockStoryGenerationProvider();

        const result = await provider.generateStory(makeInput({ language: 'ru' }));

        expect(result.storyPlan.title).toMatch(CYRILLIC);
        expect(result.storyPlan.educationalMessage).toMatch(CYRILLIC);
        expect(result.bookPreview.backCover.message).toMatch(CYRILLIC);
        for (const page of result.storyPlan.pages) {
          expect(page.storyText).toMatch(CYRILLIC);
        }
      });

      it('generates English story content (no Cyrillic) when language is "en"', async () => {
        const provider = new MockStoryGenerationProvider();

        const result = await provider.generateStory(makeInput({ language: 'en' }));

        expect(result.storyPlan.title).not.toMatch(CYRILLIC);
        for (const page of result.storyPlan.pages) {
          expect(page.storyText).not.toMatch(CYRILLIC);
        }
      });

      it('falls back to English for an unrecognized language code rather than mixing languages', async () => {
        const provider = new MockStoryGenerationProvider();

        const result = await provider.generateStory(makeInput({ language: 'xx' }));

        expect(result.storyPlan.title).not.toMatch(CYRILLIC);
      });
    });

    // ── QA: child name capitalization must be preserved (Book Output QA phase) ──

    describe('child name capitalization', () => {
      it('never lowercases the leading letter of a capitalized childName in English story text', async () => {
        const provider = new MockStoryGenerationProvider();

        const result = await provider.generateStory(makeInput({ childName: 'Maya' }));

        for (const page of result.storyPlan.pages) {
          expect(page.storyText).not.toContain(' maya');
          expect(page.narration).not.toContain(' maya');
          expect(page.sceneDescription.startsWith('maya')).toBe(false);
        }
        expect(result.bookPreview.cover.childName).toBe('Maya');
      });

      it('preserves capitalization in Russian story text too', async () => {
        const provider = new MockStoryGenerationProvider();

        const result = await provider.generateStory(
          makeInput({ childName: 'Maya', language: 'ru' }),
        );

        for (const page of result.storyPlan.pages) {
          expect(page.storyText).not.toContain(' maya');
        }
      });
    });

    // ── QA: fallback story must have a real beginning/middle/end, and the
    // moral must not repeat on every page (Book Output QA phase) ────────────

    describe('narrative structure', () => {
      it('only appends the moral/learningGoal sentence on the final page, not every page', async () => {
        const provider = new MockStoryGenerationProvider();

        const result = await provider.generateStory(makeInput({ pageCount: 6 }));
        const pages = result.storyPlan.pages;
        const learningGoal = result.storyPlan.educationalMessage;

        const pagesContainingMoral = pages.filter((p) => p.storyText.includes(learningGoal));
        expect(pagesContainingMoral).toHaveLength(1);
        expect(pagesContainingMoral[0]?.pageNumber).toBe(pages[pages.length - 1]?.pageNumber);
      });

      it('does not repeat the exact same middle-page filler sentence on every page', async () => {
        const provider = new MockStoryGenerationProvider();

        const result = await provider.generateStory(makeInput({ pageCount: 8 }));
        const middlePages = result.storyPlan.pages.slice(1, -1);
        const middleTexts = middlePages.map((p) => p.storyText);

        expect(new Set(middleTexts).size).toBeGreaterThan(1);
      });

      it('the first page opens with the story opening hook', async () => {
        const provider = new MockStoryGenerationProvider();

        const result = await provider.generateStory(makeInput());

        expect(result.storyPlan.pages[0]?.storyText.startsWith(result.storyPlan.openingHook)).toBe(
          true,
        );
      });

      it('the last page includes the story resolution', async () => {
        const provider = new MockStoryGenerationProvider();

        const result = await provider.generateStory(makeInput());
        const pages = result.storyPlan.pages;

        expect(pages[pages.length - 1]?.storyText).toContain(result.storyPlan.resolution);
      });
    });

    // ── QA: Russian fallback grammar must be natural, not just Cyrillic
    // (code review follow-up) ──────────────────────────────────────────────

    describe('Russian fallback grammar', () => {
      it('declines the child name to genitive case in the title ("Приключение Майи", not "Майя")', async () => {
        const provider = new MockStoryGenerationProvider();

        const result = await provider.generateStory(
          makeInput({ childName: 'Майя', language: 'ru' }),
        );

        expect(result.storyPlan.title).toContain('Приключение Майи');
        expect(result.storyPlan.title).not.toContain('Приключение Майя:');
      });

      it('declines other common feminine name endings to genitive case', async () => {
        const provider = new MockStoryGenerationProvider();

        const anna = await provider.generateStory(makeInput({ childName: 'Анна', language: 'ru' }));
        const olga = await provider.generateStory(
          makeInput({ childName: 'Ольга', language: 'ru' }),
        );

        expect(anna.storyPlan.title).toContain('Приключение Анны');
        expect(olga.storyPlan.title).toContain('Приключение Ольги');
      });

      it('leaves a non-declining name unchanged rather than guessing at morphology', async () => {
        const provider = new MockStoryGenerationProvider();

        const result = await provider.generateStory(
          makeInput({ childName: 'Grace', language: 'ru' }),
        );

        expect(result.storyPlan.title).toContain('Приключение Grace');
      });

      it('uses a default educational message that never requires theme case agreement', async () => {
        const provider = new MockStoryGenerationProvider();

        const result = await provider.generateStory(
          makeInput({ childName: 'Майя', theme: 'Поездка на море', language: 'ru' }),
        );

        expect(result.storyPlan.educationalMessage).toBe(
          'В этой истории мы учимся смелости, доброте и вере в себя.',
        );
        expect(result.storyPlan.educationalMessage).not.toContain('Через Поездка на море');
      });
    });

    // ── QA: the selected theme should be reflected in every chapter, not
    // just the title/moral, and generic fantasy filler shouldn't leak into a
    // realistic/travel-based theme (Pagination + Theme Consistency phase) ──

    describe('theme consistency (sea trip)', () => {
      it('reflects a realistic sea-trip theme with concrete travel/beach nouns in every chapter, not generic fantasy', async () => {
        const provider = new MockStoryGenerationProvider();

        const result = await provider.generateStory(
          makeInput({ theme: 'Поездка на море', language: 'ru', pageCount: 12 }),
        );

        const settings = result.storyPlan.chapters.map((c) => c.setting);
        const allText = settings.join(' ');
        expect(allText).toMatch(/чемодан|дорог|поезд|самолёт|машин/i);
        expect(allText).toMatch(/пляж|море|песок|волн/i);
        // The generic fantasy pack's "enchanted forest" must not leak in.
        expect(allText).not.toContain('лес');
      });

      it('reflects an English sea-trip theme with suitcase/road/train/car/plane and beach/waves/sand/shells nouns', async () => {
        const provider = new MockStoryGenerationProvider();

        const result = await provider.generateStory(
          makeInput({ theme: 'sea trip', language: 'en', pageCount: 12 }),
        );

        const allText = result.storyPlan.chapters
          .map((c) => `${c.setting} ${c.summary} ${c.keyEvents.join(' ')}`)
          .join(' ');
        expect(allText).toMatch(/suitcase|road|train|car|plane/i);
        expect(allText).toMatch(/beach|waves|sand|shells/i);
        expect(allText).not.toMatch(/enchanted forest/i);
      });

      it('does not reclassify an unrelated theme into the sea-trip pack', async () => {
        const provider = new MockStoryGenerationProvider();

        const result = await provider.generateStory(makeInput({ theme: 'friendship' }));

        const allText = result.storyPlan.chapters.map((c) => c.setting).join(' ');
        expect(allText).not.toMatch(/suitcase|beach/i);
      });
    });

    // ── QA: chapter-opening transitions should vary instead of repeating
    // the same literal phrase on every chapter (Pagination + Theme
    // Consistency phase) ──────────────────────────────────────────────────

    describe('chapter opener variety', () => {
      it('does not open every chapter with the exact same transition sentence', async () => {
        const provider = new MockStoryGenerationProvider();

        const result = await provider.generateStory(makeInput({ pageCount: 12 }));
        // First page of every chapter is at index 0, 2, 4, ... (PAGES_PER_CHAPTER=2)
        const openerNarrations = result.storyPlan.pages
          .filter((_, i) => i % 2 === 0)
          .map((p) => p.narration);

        expect(new Set(openerNarrations).size).toBeGreaterThan(1);
      });

      it('varies the Russian chapter-opening transition across chapters too', async () => {
        const provider = new MockStoryGenerationProvider();

        const result = await provider.generateStory(makeInput({ language: 'ru', pageCount: 12 }));
        const openerNarrations = result.storyPlan.pages
          .filter((_, i) => i % 2 === 0)
          .map((p) => p.narration);

        expect(new Set(openerNarrations).size).toBeGreaterThan(1);
      });
    });
  });
});
