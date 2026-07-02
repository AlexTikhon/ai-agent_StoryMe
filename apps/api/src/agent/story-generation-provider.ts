import {
  Pronouns,
  type BookPreview,
  type CharacterCard,
  type GeneratedImageEntry,
  type IllustrationPlan,
  type ImageGenerationResult,
  type PagePlan,
  type StoryPlan,
} from '@book/types';

export interface StoryGenerationInput {
  bookId: string;
  childName: string;
  childAge: number;
  theme: string;
  language: string;
}

export type ResolvedPagePlan = PagePlan & { storyText: string; illustration: IllustrationPlan };

export interface StoryGenerationResult {
  characterCard: CharacterCard;
  storyPlan: StoryPlan & { pages: ResolvedPagePlan[] };
  bookPreview: BookPreview;
  imageGenerationResult: ImageGenerationResult;
}

/**
 * Internal boundary for producing a book's character/story/page/image-metadata
 * plan. AgentService depends on this interface rather than owning the
 * generation logic directly, so a future real-LLM provider can implement it
 * and return the same shapes without touching AgentService or anything
 * downstream (layout, PDF render, storage). See
 * docs/local-generation-pipeline.md for the current mock behavior and how a
 * real provider should slot in.
 */
export interface StoryGenerationProvider {
  /** 'mock' | 'openai' — surfaced only for generation diagnostics, never used for control flow. */
  readonly providerName?: string;
  /** Underlying model identifier, if applicable (mock providers have none). */
  readonly modelName?: string;
  generateStory(input: StoryGenerationInput): Promise<StoryGenerationResult>;
}

export const STORY_GENERATION_PROVIDER_TOKEN = 'STORY_GENERATION_PROVIDER';

function buildCharacterCard(name: string, age: number): CharacterCard {
  return {
    name,
    age,
    pronouns: Pronouns.SheHer,
    appearance: {
      hairColor: 'brown',
      hairStyle: 'wavy',
      eyeColor: 'brown',
      skinTone: 'medium',
      distinctiveFeatures: ['bright smile'],
    },
    personality: {
      traits: ['curious', 'brave', 'kind'],
      favoriteAnimals: ['rabbit', 'butterfly'],
      favoriteColors: ['purple', 'yellow'],
      favoriteToys: ['building blocks'],
      hobbies: ['drawing', 'exploring'],
    },
    visualAnchor: `A ${age}-year-old child named ${name} with wavy brown hair, brown eyes, and a bright smile`,
    narrativeDescription: `${name} is a ${age}-year-old child full of curiosity and wonder, always ready for a new adventure.`,
  };
}

function buildStoryPlan(name: string, theme: string): StoryPlan {
  const titleTheme = theme.split(' ')[0] ?? theme;
  return {
    title: `${name}'s ${titleTheme} Adventure`,
    theme,
    educationalMessage: `Through ${theme}, we learn the importance of courage, kindness, and believing in ourselves.`,
    openingHook: `One sunny morning, ${name} discovered something magical that would change everything.`,
    resolution: `${name} returned home with a heart full of joy, knowing that every adventure begins with a single brave step.`,
    chapters: [
      {
        chapterNumber: 1,
        title: 'A Magical Discovery',
        summary: `${name} finds something unexpected and decides to investigate.`,
        setting: 'The backyard garden',
        emotionalArc: 'curiosity to excitement',
        keyEvents: [`${name} notices a glowing light`, 'A friendly creature appears'],
        illustrableScenes: [`${name} discovering a glowing light in the garden`],
      },
      {
        chapterNumber: 2,
        title: 'The Journey Begins',
        summary: `${name} sets off on a journey and faces a small challenge with courage.`,
        setting: 'An enchanted forest',
        emotionalArc: 'nervousness to bravery',
        keyEvents: [
          `${name} and friend enter the forest`,
          'They face a small challenge and overcome it',
        ],
        illustrableScenes: [`${name} and friend walking through colorful mushrooms`],
      },
      {
        chapterNumber: 3,
        title: 'Home Again',
        summary: `${name} returns home having learned something important about ${theme}.`,
        setting: 'Home',
        emotionalArc: 'pride and happiness',
        keyEvents: [`${name} shares the story with family`, 'A final magical moment'],
        illustrableScenes: [`${name} hugging family with a big smile`],
      },
    ],
  };
}

function buildPagePlan(storyPlan: StoryPlan): PagePlan[] {
  const pages: PagePlan[] = [];
  let pageNumber = 1;

  for (let chapterIndex = 0; chapterIndex < storyPlan.chapters.length; chapterIndex++) {
    const chapter = storyPlan.chapters[chapterIndex]!;
    for (let pageInChapter = 1; pageInChapter <= 2; pageInChapter++) {
      const scene =
        chapter.illustrableScenes[pageInChapter - 1] ??
        `Scene ${pageInChapter} of ${chapter.title}`;
      pages.push({
        pageNumber: pageNumber++,
        chapterIndex,
        title: `${chapter.title} — Part ${pageInChapter}`,
        sceneDescription: scene,
        narration:
          pageInChapter === 1
            ? `${chapter.summary} It all began with ${scene.charAt(0).toLowerCase() + scene.slice(1)}.`
            : `The story continued as ${chapter.emotionalArc} filled the air.`,
        illustrationPrompt: `Children's book illustration: ${scene}, ${chapter.setting}, bright and colorful, watercolor style`,
        learningGoal: storyPlan.educationalMessage,
      });
    }
  }

  return pages;
}

function buildStoryDraft(
  characterCard: CharacterCard,
  storyPlanWithPages: StoryPlan & { pages: PagePlan[] },
): StoryPlan & { pages: Array<PagePlan & { storyText: string }> } {
  const name = characterCard.name;
  const { theme, openingHook } = storyPlanWithPages;

  const pages = storyPlanWithPages.pages.map((page, pageIndex) => {
    const lead =
      pageIndex === 0
        ? openingHook
        : `${name} thought about ${theme} and took another brave step forward.`;
    const storyText = `${lead} ${page.narration} ${name} knew deep down: ${page.learningGoal}`;
    return { ...page, storyText };
  });

  return { ...storyPlanWithPages, pages };
}

function buildIllustrationPlan(
  characterCard: CharacterCard,
  storyPlanWithDraft: StoryPlan & { pages: Array<PagePlan & { storyText: string }> },
): StoryPlan & { pages: Array<PagePlan & { storyText: string; illustration: IllustrationPlan }> } {
  const pages = storyPlanWithDraft.pages.map(
    (page): PagePlan & { storyText: string; illustration: IllustrationPlan } => {
      const chapter = storyPlanWithDraft.chapters[page.chapterIndex];
      const mood = chapter ? `${chapter.emotionalArc}, child-friendly` : 'joyful, child-friendly';

      const illustration: IllustrationPlan = {
        prompt: `${characterCard.visualAnchor}, ${page.sceneDescription}. ${page.illustrationPrompt}`,
        negativePrompt: 'blurry, distorted face, extra limbs, scary, violent, text, watermark',
        style: 'warm children book illustration, soft colors, friendly character design',
        aspectRatio: '4:3',
        characters: [characterCard.name],
        setting: page.sceneDescription,
        mood,
        consistencyNotes: `Keep ${characterCard.name} visually consistent: ${characterCard.visualAnchor}. Use the same color palette and character design throughout.`,
      };

      return { ...page, storyText: page.storyText as string, illustration };
    },
  );

  return { ...storyPlanWithDraft, pages };
}

const PAGE_LAYOUTS = ['image_top_text_bottom', 'text_left_image_right'] as const;

export function buildBookPreview(
  childProfile: { childName: string; childAge: number; language: string },
  characterCard: CharacterCard,
  storyPlanFinal: StoryPlan & {
    pages: Array<PagePlan & { storyText: string; illustration: IllustrationPlan }>;
  },
): BookPreview {
  const { childName, childAge, language } = childProfile;
  const { title, theme, educationalMessage } = storyPlanFinal;
  const subtitle = storyPlanFinal.subtitle ?? `A ${theme} story for ${childName}`;

  const pages = storyPlanFinal.pages.map((page, index) => ({
    pageNumber: page.pageNumber,
    title: page.title,
    text: page.storyText as string,
    illustrationPrompt: (page.illustration as IllustrationPlan).prompt,
    layout: PAGE_LAYOUTS[index % PAGE_LAYOUTS.length]!,
    learningGoal: page.learningGoal,
  }));

  return {
    title,
    subtitle,
    cover: {
      title,
      subtitle,
      childName,
      illustrationPrompt: `${characterCard.visualAnchor}, standing on the cover of a children's book titled "${title}", warm and inviting, watercolor style`,
    },
    pages,
    backCover: {
      message: `The End! We hope ${childName} enjoyed this adventure. Keep exploring, keep dreaming!`,
      educationalSummary: educationalMessage,
    },
    metadata: {
      language,
      theme,
      childAge,
      totalPages: pages.length,
      generatedBy: 'LocalPipelineAgent',
    },
  };
}

export function buildImageGenerationResult(
  bookId: string,
  bookPreview: BookPreview,
): ImageGenerationResult {
  const images: GeneratedImageEntry[] = [];

  images.push({
    id: `${bookId}-cover`,
    kind: 'cover',
    prompt: bookPreview.cover.illustrationPrompt,
    provider: 'local_mock',
    status: 'complete',
    imageUrl: `/mock-images/${bookId}/cover.svg`,
    altText: `Cover illustration for ${bookPreview.title}`,
    width: 768,
    height: 1024,
    seed: `${bookId}:cover:0`,
  });

  for (const page of bookPreview.pages) {
    images.push({
      id: `${bookId}-page-${page.pageNumber}`,
      kind: 'page',
      pageNumber: page.pageNumber,
      prompt: page.illustrationPrompt,
      provider: 'local_mock',
      status: 'complete',
      imageUrl: `/mock-images/${bookId}/page-${page.pageNumber}.svg`,
      altText: `Page ${page.pageNumber} illustration`,
      width: 1024,
      height: 768,
      seed: `${bookId}:page:${page.pageNumber}`,
    });
  }

  images.push({
    id: `${bookId}-back-cover`,
    kind: 'back_cover',
    prompt: `Back cover for "${bookPreview.title}", child-friendly decorative design`,
    provider: 'local_mock',
    status: 'complete',
    imageUrl: `/mock-images/${bookId}/back-cover.svg`,
    altText: 'Back cover illustration',
    width: 768,
    height: 1024,
    seed: `${bookId}:back_cover:0`,
  });

  return {
    provider: 'local_mock',
    status: 'complete',
    images,
    createdAt: '1970-01-01T00:00:00.000Z',
  };
}

/**
 * Deterministic local stand-in for a future real-LLM StoryGenerationProvider.
 * Produces the same hand-written template output AgentService generated
 * inline before this boundary existed — same inputs always produce the same
 * character/story/page/image-metadata output, no I/O, no randomness beyond
 * hashing the book's own fields.
 */
export class MockStoryGenerationProvider implements StoryGenerationProvider {
  readonly providerName = 'mock' as const;

  async generateStory(input: StoryGenerationInput): Promise<StoryGenerationResult> {
    const { bookId, childName, childAge, theme, language } = input;

    const characterCard = buildCharacterCard(childName, childAge);
    const storyPlan = buildStoryPlan(childName, theme);
    const pages = buildPagePlan(storyPlan);
    const storyPlanWithDraft = buildStoryDraft(characterCard, { ...storyPlan, pages });
    const storyPlanFinal = buildIllustrationPlan(characterCard, storyPlanWithDraft);
    const bookPreview = buildBookPreview({ childName, childAge, language }, characterCard, storyPlanFinal);
    const imageGenerationResult = buildImageGenerationResult(bookId, bookPreview);

    return { characterCard, storyPlan: storyPlanFinal, bookPreview, imageGenerationResult };
  }
}
