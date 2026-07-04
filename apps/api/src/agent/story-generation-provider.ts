import {
  DEFAULT_BOOK_PAGE_COUNT,
  MAX_BOOK_PAGE_COUNT,
  MIN_BOOK_PAGE_COUNT,
  Pronouns,
  type BookPreview,
  type ChapterOutline,
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
  /** Target story page count. Defaults to DEFAULT_BOOK_PAGE_COUNT when omitted; providers clamp to [MIN_BOOK_PAGE_COUNT, MAX_BOOK_PAGE_COUNT]. */
  pageCount?: number | undefined;
  /** User-supplied desired educational message/lesson. When omitted, providers generate a default from theme. */
  educationalMessage?: string | undefined;
}

/** Clamps a requested page count into [MIN_BOOK_PAGE_COUNT, MAX_BOOK_PAGE_COUNT], defaulting when absent/invalid — the last line of defense behind CreateBookDto's own bounds. */
export function resolveTargetPageCount(pageCount: number | undefined): number {
  if (typeof pageCount !== 'number' || !Number.isFinite(pageCount)) {
    return DEFAULT_BOOK_PAGE_COUNT;
  }
  return Math.min(MAX_BOOK_PAGE_COUNT, Math.max(MIN_BOOK_PAGE_COUNT, Math.floor(pageCount)));
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

const PAGES_PER_CHAPTER = 2;

/**
 * Local/fallback generation currently ships full localized templates for
 * English and Russian only — the two languages this pipeline is required to
 * support correctly today. Any other `language` value (e.g. 'pl') falls back
 * to English rather than silently mixing in untranslated content; extend
 * CHAPTER_TEMPLATES_BY_LANGUAGE and STRINGS_BY_LANGUAGE together to add a
 * new language.
 */
export type TemplateLanguage = 'en' | 'ru';

export function resolveTemplateLanguage(language: string): TemplateLanguage {
  return language === 'ru' ? 'ru' : 'en';
}

/**
 * Chapter shape templates, one per possible chapter slot. Sized to cover
 * MAX_BOOK_PAGE_COUNT / PAGES_PER_CHAPTER (12 / 2 = 6) chapters — the most
 * buildStoryPlan will ever need.
 */
type ChapterTemplateBuilder = (name: string, theme: string) => ChapterOutline;

const CHAPTER_TEMPLATES_EN: ChapterTemplateBuilder[] = [
  (name) => ({
    chapterNumber: 1,
    title: 'A Magical Discovery',
    summary: `${name} finds something unexpected and decides to investigate.`,
    setting: 'The backyard garden',
    emotionalArc: 'curiosity to excitement',
    keyEvents: [`${name} notices a glowing light`, 'A friendly creature appears'],
    illustrableScenes: [`${name} discovering a glowing light in the garden`],
  }),
  (name) => ({
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
  }),
  (name, theme) => ({
    chapterNumber: 3,
    title: 'Home Again',
    summary: `${name} returns home having learned something important about ${theme}.`,
    setting: 'Home',
    emotionalArc: 'pride and happiness',
    keyEvents: [`${name} shares the story with family`, 'A final magical moment'],
    illustrableScenes: [`${name} hugging family with a big smile`],
  }),
  (name) => ({
    chapterNumber: 4,
    title: 'A New Friend',
    summary: `${name} meets someone new and learns to work together.`,
    setting: 'A sunny meadow',
    emotionalArc: 'shyness to friendship',
    keyEvents: [`${name} shares something kind`, 'A bond of trust forms'],
    illustrableScenes: [`${name} sharing a treat with a new friend in the meadow`],
  }),
  (name, theme) => ({
    chapterNumber: 5,
    title: 'A Bigger Challenge',
    summary: `${name} faces a bigger challenge tied to ${theme} and doesn't give up.`,
    setting: 'A winding river',
    emotionalArc: 'worry to determination',
    keyEvents: [`${name} hits an obstacle`, `${name} tries again and succeeds`],
    illustrableScenes: [`${name} crossing the river with determination`],
  }),
  (name) => ({
    chapterNumber: 6,
    title: 'A Joyful Celebration',
    summary: `${name} celebrates the adventure with everyone who helped along the way.`,
    setting: 'A festival under the stars',
    emotionalArc: 'gratitude and joy',
    keyEvents: [`${name} thanks new friends`, 'Everyone celebrates together'],
    illustrableScenes: [`${name} celebrating under twinkling stars with friends`],
  }),
];

/**
 * Russian mirror of CHAPTER_TEMPLATES_EN, same shape/order. The mock
 * character is hardcoded to Pronouns.SheHer (see buildCharacterCard), so verb
 * forms here consistently use feminine agreement.
 */
const CHAPTER_TEMPLATES_RU: ChapterTemplateBuilder[] = [
  (name) => ({
    chapterNumber: 1,
    title: 'Волшебное открытие',
    summary: `${name} находит что-то неожиданное и решает это разузнать.`,
    setting: 'Сад за домом',
    emotionalArc: 'любопытство сменяется восторгом',
    keyEvents: [`${name} замечает мерцающий свет`, 'Появляется дружелюбное существо'],
    illustrableScenes: [`${name} находит мерцающий свет в саду`],
  }),
  (name) => ({
    chapterNumber: 2,
    title: 'Начало пути',
    summary: `${name} отправляется в путешествие и смело встречает первое испытание.`,
    setting: 'Волшебный лес',
    emotionalArc: 'волнение сменяется смелостью',
    keyEvents: [`${name} и друг входят в лес`, 'Они преодолевают небольшое препятствие'],
    illustrableScenes: [`${name} и друг идут через разноцветные грибы`],
  }),
  (name, theme) => ({
    chapterNumber: 3,
    title: 'Снова дома',
    summary: `${name} возвращается домой, узнав кое-что важное о ${theme}.`,
    setting: 'Дом',
    emotionalArc: 'гордость и радость',
    keyEvents: [`${name} делится историей с семьёй`, 'Последний волшебный момент'],
    illustrableScenes: [`${name} обнимает семью с широкой улыбкой`],
  }),
  (name) => ({
    chapterNumber: 4,
    title: 'Новый друг',
    summary: `${name} знакомится с новым другом и учится работать сообща.`,
    setting: 'Солнечный луг',
    emotionalArc: 'застенчивость сменяется дружбой',
    keyEvents: [`${name} делится чем-то добрым`, 'Рождается доверие'],
    illustrableScenes: [`${name} угощает нового друга на лугу`],
  }),
  (name, theme) => ({
    chapterNumber: 5,
    title: 'Большое испытание',
    summary: `${name} сталкивается с более серьёзным испытанием, связанным с ${theme}, и не сдаётся.`,
    setting: 'Извилистая река',
    emotionalArc: 'тревога сменяется решимостью',
    keyEvents: [`${name} встречает препятствие`, `${name} пробует снова и добивается успеха`],
    illustrableScenes: [`${name} переходит реку с решимостью`],
  }),
  (name) => ({
    chapterNumber: 6,
    title: 'Радостный праздник',
    summary: `${name} празднует приключение вместе со всеми, кто помогал в пути.`,
    setting: 'Праздник под звёздами',
    emotionalArc: 'благодарность и радость',
    keyEvents: [`${name} благодарит новых друзей`, 'Все вместе празднуют'],
    illustrableScenes: [`${name} празднует под мерцающими звёздами вместе с друзьями`],
  }),
];

function chapterTemplatesFor(lang: TemplateLanguage): ChapterTemplateBuilder[] {
  return lang === 'ru' ? CHAPTER_TEMPLATES_RU : CHAPTER_TEMPLATES_EN;
}

interface LocalizedStrings {
  title: (name: string, titleTheme: string) => string;
  subtitle: (theme: string, name: string) => string;
  educationalMessageDefault: (theme: string) => string;
  openingHook: (name: string) => string;
  resolution: (name: string) => string;
  backCoverMessage: (name: string) => string;
  pageTitle: (chapterTitle: string, partNumber: number) => string;
  /** Lead-in sentence for the first page of a chapter. Never case-folds `scene` — it commonly starts with the child's name and must keep its capitalization. */
  pageLeadFirstInChapter: (chapterSummary: string, scene: string) => string;
  pageLeadOtherInChapter: (emotionalArc: string) => string;
  /** Only ever appended on the story's final page — the moral must not repeat on every page. */
  moralSentence: (name: string, learningGoal: string) => string;
  /** Cycled by page index for non-first, non-last pages so consecutive pages don't open with an identical filler sentence. */
  middleConnectors: Array<(name: string) => string>;
}

const STRINGS_BY_LANGUAGE: Record<TemplateLanguage, LocalizedStrings> = {
  en: {
    title: (name, titleTheme) => `${name}'s ${titleTheme} Adventure`,
    subtitle: (theme, name) => `A ${theme} story for ${name}`,
    educationalMessageDefault: (theme) =>
      `Through ${theme}, we learn the importance of courage, kindness, and believing in ourselves.`,
    openingHook: (name) =>
      `One sunny morning, ${name} discovered something magical that would change everything.`,
    resolution: (name) =>
      `${name} returned home with a heart full of joy, knowing that every adventure begins with a single brave step.`,
    backCoverMessage: (name) =>
      `The End! We hope ${name} enjoyed this adventure. Keep exploring, keep dreaming!`,
    pageTitle: (chapterTitle, partNumber) => `${chapterTitle} — Part ${partNumber}`,
    pageLeadFirstInChapter: (summary, scene) => `${summary} It all began right here: ${scene}.`,
    pageLeadOtherInChapter: (emotionalArc) =>
      `The story continued as ${emotionalArc} filled the air.`,
    moralSentence: (name, learningGoal) => `${name} knew deep down: ${learningGoal}`,
    middleConnectors: [
      (name) => `Along the way, ${name} felt a spark of curiosity.`,
      (name) => `Just then, something new caught ${name}'s eye.`,
      (name) => `With a steady heart, ${name} kept going.`,
      () => `Step by step, the adventure kept unfolding.`,
    ],
  },
  ru: {
    title: (name, titleTheme) => `Приключение ${name}: ${titleTheme}`,
    subtitle: (theme, name) => `История о ${theme} для ${name}`,
    educationalMessageDefault: (theme) =>
      `Через ${theme} мы учимся смелости, доброте и вере в себя.`,
    openingHook: (name) =>
      `Одним солнечным утром ${name} обнаружила нечто волшебное, что изменило всё.`,
    resolution: (name) =>
      `${name} вернулась домой с сердцем, полным радости, зная, что каждое приключение начинается с одного смелого шага.`,
    backCoverMessage: (name) =>
      `Конец! Мы надеемся, что тебе понравилось это приключение, ${name}. Продолжай исследовать, продолжай мечтать!`,
    pageTitle: (chapterTitle, partNumber) => `${chapterTitle} — Часть ${partNumber}`,
    pageLeadFirstInChapter: (summary, scene) => `${summary} Всё началось именно здесь: ${scene}.`,
    pageLeadOtherInChapter: (emotionalArc) => `История продолжалась: ${emotionalArc}.`,
    moralSentence: (name, learningGoal) => `В глубине души ${name} знала: ${learningGoal}`,
    middleConnectors: [
      (name) => `По пути ${name} почувствовала лёгкое любопытство.`,
      (name) => `Именно тогда ${name} заметила кое-что новое.`,
      (name) => `Не теряя присутствия духа, ${name} продолжала путь.`,
      () => `Шаг за шагом приключение продолжало раскрываться.`,
    ],
  },
};

function buildStoryPlan(
  name: string,
  theme: string,
  pageCount: number,
  lang: TemplateLanguage,
  educationalMessage?: string,
): StoryPlan {
  const strings = STRINGS_BY_LANGUAGE[lang];
  const titleTheme = theme.split(' ')[0] ?? theme;
  const chapterTemplates = chapterTemplatesFor(lang);
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

function buildPagePlan(
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
        `Scene ${pageInChapter} of ${chapter.title}`;
      pages.push({
        pageNumber: pageNumber++,
        chapterIndex,
        title: strings.pageTitle(chapter.title, pageInChapter),
        sceneDescription: scene,
        narration:
          pageInChapter === 1
            ? strings.pageLeadFirstInChapter(chapter.summary, scene)
            : strings.pageLeadOtherInChapter(chapter.emotionalArc),
        // Illustration prompts stay in English regardless of story language —
        // they are internal metadata for a future image-generation model, not
        // reader-facing story text (see buildIllustrationPlan below).
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
  const strings = STRINGS_BY_LANGUAGE[resolveTemplateLanguage(language)];
  const { title, theme, educationalMessage } = storyPlanFinal;
  const subtitle = storyPlanFinal.subtitle ?? strings.subtitle(theme, childName);

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
    const { bookId, childName, childAge, theme, language, educationalMessage } = input;
    const pageCount = resolveTargetPageCount(input.pageCount);
    const lang = resolveTemplateLanguage(language);

    const characterCard = buildCharacterCard(childName, childAge);
    const storyPlan = buildStoryPlan(childName, theme, pageCount, lang, educationalMessage);
    const pages = buildPagePlan(storyPlan, pageCount, lang);
    const storyPlanWithDraft = buildStoryDraft(characterCard, { ...storyPlan, pages }, lang);
    const storyPlanFinal = buildIllustrationPlan(characterCard, storyPlanWithDraft);
    const bookPreview = buildBookPreview(
      { childName, childAge, language },
      characterCard,
      storyPlanFinal,
    );
    const imageGenerationResult = buildImageGenerationResult(bookId, bookPreview);

    return { characterCard, storyPlan: storyPlanFinal, bookPreview, imageGenerationResult };
  }
}
