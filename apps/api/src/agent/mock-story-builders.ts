import {
  Pronouns,
  type BookPreview,
  type CharacterCard,
  type CharacterProfile,
  type GeneratedImageEntry,
  type IllustrationPlan,
  type ImageGenerationResult,
  type PagePlan,
  type StoryPlan,
} from '@book/types';
import { buildCharacterConsistencyBlock } from './story-generation-contracts';
import {
  PAGES_PER_CHAPTER,
  STRINGS_BY_LANGUAGE,
  chapterTemplatesFor,
  resolveTemplateLanguage,
  resolveThemeCategory,
  type TemplateLanguage,
} from './mock-story-templates';

export function buildCharacterCard(name: string, age: number): CharacterCard {
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

export function buildStoryPlan(
  name: string,
  theme: string,
  pageCount: number,
  lang: TemplateLanguage,
  educationalMessage?: string,
): StoryPlan {
  const strings = STRINGS_BY_LANGUAGE[lang];
  const titleTheme = theme.split(' ')[0] ?? theme;
  const chapterTemplates = chapterTemplatesFor(lang, resolveThemeCategory(theme));
  const chapterCount = Math.min(chapterTemplates.length, Math.ceil(pageCount / PAGES_PER_CHAPTER));
  const chapters = chapterTemplates.slice(0, chapterCount).map((build, index) => ({
    ...build(name, theme),
    chapterNumber: index + 1,
  }));

  return {
    title: strings.title(name, titleTheme),
    theme,
    educationalMessage: educationalMessage ?? strings.educationalMessageDefault(theme),
    openingHook: strings.openingHook(name),
    resolution: strings.resolution(name),
    chapters,
  };
}

export function buildPagePlan(
  storyPlan: StoryPlan,
  pageCount: number,
  lang: TemplateLanguage,
): PagePlan[] {
  const strings = STRINGS_BY_LANGUAGE[lang];
  const pages: PagePlan[] = [];
  let pageNumber = 1;

  for (let chapterIndex = 0; chapterIndex < storyPlan.chapters.length; chapterIndex++) {
    if (pages.length >= pageCount) break;
    const chapter = storyPlan.chapters[chapterIndex]!;
    const pagesInChapter = Math.min(PAGES_PER_CHAPTER, pageCount - pages.length);
    for (let pageInChapter = 1; pageInChapter <= pagesInChapter; pageInChapter++) {
      const scene =
        chapter.illustrableScenes[pageInChapter - 1] ??
        strings.sceneFallback(pageInChapter, chapter.title);
      pages.push({
        pageNumber: pageNumber++,
        chapterIndex,
        title: strings.pageTitle(chapter.title, pageInChapter),
        sceneDescription: scene,
        narration:
          pageInChapter === 1
            ? strings.chapterOpeners[chapterIndex % strings.chapterOpeners.length]!(
                chapter.summary,
                scene,
              )
            : strings.pageLeadOtherInChapter(chapter.emotionalArc),
        illustrationPrompt: strings.illustrationPrompt(scene, chapter.setting),
        learningGoal: storyPlan.educationalMessage,
      });
    }
  }

  return pages;
}

export function buildStoryDraft(
  characterCard: CharacterCard,
  storyPlanWithPages: StoryPlan & { pages: PagePlan[] },
  lang: TemplateLanguage,
): StoryPlan & { pages: Array<PagePlan & { storyText: string }> } {
  const strings = STRINGS_BY_LANGUAGE[lang];
  const name = characterCard.name;
  const { openingHook, resolution } = storyPlanWithPages;
  const totalPages = storyPlanWithPages.pages.length;

  const pages = storyPlanWithPages.pages.map((page, pageIndex) => {
    const isFirst = pageIndex === 0;
    const isLast = pageIndex === totalPages - 1;

    let storyText: string;
    if (isFirst) {
      // Beginning: opening hook + this page's scene-setting lead-in.
      storyText = `${openingHook} ${page.narration}`;
    } else if (isLast) {
      // End: this page's narration + the story's resolution, with the moral
      // appearing here only — not repeated on every page.
      storyText = `${page.narration} ${resolution} ${strings.moralSentence(name, page.learningGoal)}`;
    } else {
      // Middle: a varied connector (cycled by position, not repeated
      // verbatim on every page) plus this page's own plot-advancing narration.
      const connector =
        strings.middleConnectors[pageIndex % strings.middleConnectors.length]!(name);
      storyText = `${connector} ${page.narration}`;
    }
    return { ...page, storyText };
  });

  return { ...storyPlanWithPages, pages };
}

export function buildIllustrationPlan(
  characterCard: CharacterCard,
  characterProfile: CharacterProfile,
  storyPlanWithDraft: StoryPlan & { pages: Array<PagePlan & { storyText: string }> },
): StoryPlan & { pages: Array<PagePlan & { storyText: string; illustration: IllustrationPlan }> } {
  const consistencyBlock = buildCharacterConsistencyBlock(characterProfile);

  const pages = storyPlanWithDraft.pages.map(
    (page): PagePlan & { storyText: string; illustration: IllustrationPlan } => {
      const chapter = storyPlanWithDraft.chapters[page.chapterIndex];
      const mood = chapter ? `${chapter.emotionalArc}, child-friendly` : 'joyful, child-friendly';

      const illustration: IllustrationPlan = {
        prompt: `${characterCard.visualAnchor}, ${page.sceneDescription}. ${page.illustrationPrompt} ${consistencyBlock}`,
        negativePrompt: 'blurry, distorted face, extra limbs, scary, violent, text, watermark',
        style: characterProfile.illustrationStyle,
        aspectRatio: '4:3',
        characters: [characterCard.name],
        setting: page.sceneDescription,
        mood,
        consistencyNotes: `Keep ${characterCard.name} visually consistent: ${characterCard.visualAnchor}. ${consistencyBlock}`,
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
  characterProfile: CharacterProfile,
  storyPlanFinal: StoryPlan & {
    pages: Array<PagePlan & { storyText: string; illustration: IllustrationPlan }>;
  },
): BookPreview {
  const { childName, childAge, language } = childProfile;
  const strings = STRINGS_BY_LANGUAGE[resolveTemplateLanguage(language)];
  const { title, theme, educationalMessage } = storyPlanFinal;
  const subtitle = storyPlanFinal.subtitle ?? strings.subtitle(theme, childName);
  const consistencyBlock = buildCharacterConsistencyBlock(characterProfile);

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
      // Deliberately never quotes the book title here — asking an image
      // model to render title text produces broken/cropped text inside the
      // artwork. The PDF renderer overlays the real title as PDF text
      // separately (see pdf-renderer.ts).
      illustrationPrompt: `${characterCard.visualAnchor}, standing on the cover of a children's picture book, warm and inviting, watercolor style. ${consistencyBlock}`,
    },
    pages,
    backCover: {
      message: strings.backCoverMessage(childName),
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
  characterProfile: CharacterProfile,
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
    // Deliberately never quotes the book title — see the cover prompt
    // comment in buildBookPreview above; the PDF renderer overlays real text
    // separately.
    prompt: `Decorative back-cover illustration for a children's picture book, warm and inviting themed background, no title or text. ${buildCharacterConsistencyBlock(characterProfile)}`,
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
