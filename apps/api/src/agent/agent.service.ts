import { Inject, Injectable, Logger } from '@nestjs/common';
import { AgentLogStatus, AgentStep, BookStatus, Prisma, type Book } from '@prisma/client';
import { renderStorybookPdf } from '../pdf/pdf-renderer';
import { PDF_STORAGE_TOKEN, type PdfStorage } from '../pdf/pdf-storage';
import {
  buildImageBufferResolver,
  IMAGE_ASSET_STORAGE_TOKEN,
  type ImageAssetStorage,
} from '../images/image-asset-storage';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../database/prisma.service';
import {
  Pronouns,
  type BookLayout,
  type BookLayoutEntry,
  type BookPreview,
  type CharacterCard,
  type GeneratedImageEntry,
  type IllustrationPlan,
  type ImageGenerationResult,
  type PagePlan,
  type StoryPlan,
} from '@book/types';

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

function buildBookPreview(
  book: Book,
  characterCard: CharacterCard,
  storyPlanFinal: StoryPlan & {
    pages: Array<PagePlan & { storyText: string; illustration: IllustrationPlan }>;
  },
): BookPreview {
  const childName = book.childName ?? 'Alex';
  const childAge = book.childAge ?? 6;
  const language = (book.language as string) ?? 'en';
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

function buildImageGenerationResult(
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

// ── Layout engine constants ────────────────────────────────────────────────────

const LAYOUT_CANVAS = { width: 2400, height: 2400, unit: 'px' as const };
const LAYOUT_SAFE_AREA = { x: 180, y: 180, width: 2040, height: 2040 };
const LAYOUT_BLEED = 90;
const LAYOUT_DISPLAY_FONT = 'Fraunces';
const LAYOUT_BODY_FONT = 'Plus Jakarta Sans';
const LAYOUT_PAGE_TEMPLATES = [
  'image_top_text_bottom',
  'text_left_image_right',
  'image_left_text_right',
] as const;

function buildBookLayout(
  bookId: string,
  bookPreview: BookPreview,
  imageResult: ImageGenerationResult,
): BookLayout {
  const entries: BookLayoutEntry[] = [];

  // Cover — full-bleed image with title overlay
  const coverImage = imageResult.images.find((img) => img.kind === 'cover');
  entries.push({
    id: `${bookId}-layout-cover`,
    kind: 'cover',
    template: 'cover_full_bleed',
    trimSize: 'square_8x8',
    canvas: LAYOUT_CANVAS,
    safeArea: LAYOUT_SAFE_AREA,
    bleed: LAYOUT_BLEED,
    ...(coverImage
      ? {
          imageBlock: {
            box: { x: 0, y: 0, width: 2400, height: 2400 },
            imageUrl: coverImage.imageUrl,
            altText: coverImage.altText,
            objectFit: 'cover' as const,
          },
        }
      : {}),
    textBlock: {
      box: { x: 180, y: 1620, width: 2040, height: 600 },
      text: bookPreview.cover.title,
      fontFamily: LAYOUT_DISPLAY_FONT,
      fontSize: 32,
      lineHeight: 1.2,
      align: 'center',
      verticalAlign: 'bottom',
      color: '#FFFFFF',
    },
    notes: ['Full-bleed cover image; title overlaid at bottom within safe area'],
  });

  // Interior pages — cycle through three templates deterministically
  for (const page of bookPreview.pages) {
    const pageImage = imageResult.images.find(
      (img) => img.kind === 'page' && img.pageNumber === page.pageNumber,
    );
    const template = LAYOUT_PAGE_TEMPLATES[(page.pageNumber - 1) % LAYOUT_PAGE_TEMPLATES.length]!;

    let imageBox: { x: number; y: number; width: number; height: number };
    let textBox: { x: number; y: number; width: number; height: number };

    if (template === 'image_top_text_bottom') {
      imageBox = { x: 180, y: 180, width: 2040, height: 1210 };
      textBox = { x: 180, y: 1420, width: 2040, height: 800 };
    } else if (template === 'text_left_image_right') {
      textBox = { x: 180, y: 180, width: 855, height: 2040 };
      imageBox = { x: 1065, y: 180, width: 1155, height: 2040 };
    } else {
      imageBox = { x: 180, y: 180, width: 1230, height: 2040 };
      textBox = { x: 1440, y: 180, width: 780, height: 2040 };
    }

    entries.push({
      id: `${bookId}-layout-page-${page.pageNumber}`,
      kind: 'page',
      pageNumber: page.pageNumber,
      template,
      trimSize: 'square_8x8',
      canvas: LAYOUT_CANVAS,
      safeArea: LAYOUT_SAFE_AREA,
      bleed: LAYOUT_BLEED,
      ...(pageImage
        ? {
            imageBlock: {
              box: imageBox,
              imageUrl: pageImage.imageUrl,
              altText: pageImage.altText,
              objectFit: 'cover' as const,
            },
          }
        : {}),
      textBlock: {
        box: textBox,
        text: page.text,
        fontFamily: LAYOUT_BODY_FONT,
        fontSize: 18,
        lineHeight: 1.5,
        align: 'left',
        verticalAlign: 'top',
        color: '#1C1917',
      },
      notes: [`Template: ${template}`],
    });
  }

  // Back cover — decorative image with summary text overlay
  const backImage = imageResult.images.find((img) => img.kind === 'back_cover');
  entries.push({
    id: `${bookId}-layout-back-cover`,
    kind: 'back_cover',
    template: 'back_cover_summary',
    trimSize: 'square_8x8',
    canvas: LAYOUT_CANVAS,
    safeArea: LAYOUT_SAFE_AREA,
    bleed: LAYOUT_BLEED,
    ...(backImage
      ? {
          imageBlock: {
            box: { x: 0, y: 0, width: 2400, height: 2400 },
            imageUrl: backImage.imageUrl,
            altText: backImage.altText,
            objectFit: 'cover' as const,
          },
        }
      : {}),
    textBlock: {
      box: { x: 300, y: 600, width: 1800, height: 1200 },
      text: `${bookPreview.backCover.message}\n\n${bookPreview.backCover.educationalSummary}`,
      fontFamily: LAYOUT_BODY_FONT,
      fontSize: 16,
      lineHeight: 1.6,
      align: 'center',
      verticalAlign: 'middle',
      color: '#FFFFFF',
    },
    notes: ['Back cover uses full-bleed image; summary text overlaid at center'],
  });

  return {
    status: 'complete',
    trimSize: 'square_8x8',
    entries,
    metadata: {
      title: bookPreview.title,
      childName: bookPreview.cover.childName,
      totalPages: bookPreview.pages.length,
      generatedAt: '1970-01-01T00:00:00.000Z',
    },
  };
}

@Injectable()
export class AgentService {
  private readonly logger = new Logger(AgentService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(PDF_STORAGE_TOKEN) private readonly pdfStorage: PdfStorage,
    @Inject(IMAGE_ASSET_STORAGE_TOKEN) private readonly imageAssetStorage: ImageAssetStorage,
  ) {}

  async startBookGeneration(book: Book): Promise<Book> {
    const traceId = randomUUID();
    const childName = book.childName ?? 'Alex';
    const childAge = book.childAge ?? 6;
    const theme = book.theme ?? 'adventure';

    const characterCard = buildCharacterCard(childName, childAge);
    const storyPlan = buildStoryPlan(childName, theme);
    const pages = buildPagePlan(storyPlan);
    const storyPlanWithDraft = buildStoryDraft(characterCard, { ...storyPlan, pages });
    const storyPlanFinal = buildIllustrationPlan(characterCard, storyPlanWithDraft);
    const bookPreview = buildBookPreview(book, characterCard, storyPlanFinal);
    const imageGenerationResult = buildImageGenerationResult(book.id, bookPreview);
    const bookLayout = buildBookLayout(book.id, bookPreview, imageGenerationResult);

    // Phase 1: persist all layout data and advance status to 'layout'
    await this.prisma.book.update({
      where: { id: book.id },
      data: {
        status: BookStatus.layout,
        title: storyPlan.title,
        characterCard: characterCard as unknown as Prisma.InputJsonValue,
        storyPlan: storyPlanFinal as unknown as Prisma.InputJsonValue,
        bookPreview: bookPreview as unknown as Prisma.InputJsonValue,
        imageGenerationResult: imageGenerationResult as unknown as Prisma.InputJsonValue,
        bookLayout: bookLayout as unknown as Prisma.InputJsonValue,
      },
    });

    // Phase 2: render PDF (pdf_render step)
    let previewPdfUrl: string | null = null;
    let pdfRenderLogStatus: AgentLogStatus = AgentLogStatus.success;
    let pdfRenderError: string | undefined;

    try {
      const resolveImageBuffer = await buildImageBufferResolver(
        this.imageAssetStorage,
        book.id,
        bookLayout.entries,
      );
      const buffer = await renderStorybookPdf(bookLayout, { resolveImageBuffer });
      const saved = await this.pdfStorage.savePreviewPdf(book.id, buffer);
      previewPdfUrl = saved.url;
    } catch (err) {
      pdfRenderLogStatus = AgentLogStatus.error;
      pdfRenderError = err instanceof Error ? err.message : String(err);
      this.logger.error(`PDF render failed for book ${book.id}: ${pdfRenderError}`);
    }

    // Phase 3: advance to 'complete' or 'failed' and persist PDF url/error
    const finalStatus = pdfRenderError ? BookStatus.failed : BookStatus.complete;
    const finalData: Prisma.BookUpdateInput = { status: finalStatus };
    if (previewPdfUrl !== null) {
      finalData.previewPdfUrl = previewPdfUrl;
    }
    if (pdfRenderError) {
      finalData.errorMessage = pdfRenderError;
      finalData.failedStep = AgentStep.pdf_render;
    }

    const updated = await this.prisma.book.update({
      where: { id: book.id },
      data: finalData,
    });

    await this.prisma.agentLog.createMany({
      data: [
        {
          bookId: book.id,
          agent: 'LocalPipelineAgent',
          step: AgentStep.char_build,
          status: AgentLogStatus.success,
          attempt: 1,
          traceId,
        },
        {
          bookId: book.id,
          agent: 'LocalPipelineAgent',
          step: AgentStep.story_plan,
          status: AgentLogStatus.success,
          attempt: 1,
          traceId,
        },
        {
          bookId: book.id,
          agent: 'LocalPipelineAgent',
          step: AgentStep.page_plan,
          status: AgentLogStatus.success,
          attempt: 1,
          traceId,
        },
        {
          bookId: book.id,
          agent: 'LocalPipelineAgent',
          step: AgentStep.story_draft,
          status: AgentLogStatus.success,
          attempt: 1,
          traceId,
        },
        {
          bookId: book.id,
          agent: 'LocalPipelineAgent',
          step: AgentStep.illust_plan,
          status: AgentLogStatus.success,
          attempt: 1,
          traceId,
        },
        {
          bookId: book.id,
          agent: 'LocalPipelineAgent',
          step: AgentStep.preview_ready,
          status: AgentLogStatus.success,
          attempt: 1,
          traceId,
        },
        {
          bookId: book.id,
          agent: 'LocalPipelineAgent',
          step: AgentStep.image_gen,
          status: AgentLogStatus.success,
          attempt: 1,
          traceId,
        },
        {
          bookId: book.id,
          agent: 'LocalPipelineAgent',
          step: AgentStep.layout,
          status: AgentLogStatus.success,
          attempt: 1,
          traceId,
        },
        {
          bookId: book.id,
          agent: 'LocalPipelineAgent',
          step: AgentStep.pdf_render,
          status: pdfRenderLogStatus,
          attempt: 1,
          traceId,
          ...(pdfRenderError && { error: pdfRenderError }),
        },
      ],
    });

    return updated;
  }
}
