import { vi, describe, it, expect, beforeEach } from 'vitest';
import { Logger } from '@nestjs/common';
import type { Book } from '@prisma/client';
import { AgentService } from './agent.service';
import { createMockPrisma } from '../common/test-utils/mock-prisma';
import type { PdfStorage } from '../pdf/pdf-storage';
import type { ImageAssetStorage } from '../images/image-asset-storage';
import {
  MockStoryGenerationProvider,
  type StoryGenerationProvider,
} from './story-generation-provider';
import {
  MockImageGenerationProvider,
  type ImageGenerationProvider,
} from '../images/image-generation-provider';

vi.mock('../pdf/pdf-renderer', () => ({
  renderStorybookPdf: vi.fn(),
}));

import { renderStorybookPdf } from '../pdf/pdf-renderer';

type MockPrisma = ReturnType<typeof createMockPrisma>;

function makeBook(overrides: Partial<Book> = {}): Book {
  return {
    id: 'b-1',
    userId: 'u-1',
    childProfileId: null,
    status: 'created' as Book['status'],
    request: null,
    title: null,
    dedicationText: null,
    pageCount: null,
    childName: 'Mia',
    childAge: 5,
    language: 'en' as Book['language'],
    theme: 'friendship',
    educationalMessage: null,
    characterCard: null,
    storyPlan: null,
    bookPreview: null,
    imageGenerationResult: null,
    bookLayout: null,
    chapters: null,
    imagePrompts: null,
    qualityReport: null,
    pageLayouts: null,
    coverUrl: null,
    pdfR2Key: null,
    pdfUrl: null,
    printPdfR2Key: null,
    printPdfUrl: null,
    previewPdfR2Key: null,
    previewPdfUrl: null,
    socialCardUrl: null,
    isPaid: false,
    paidAt: null,
    stripePaymentIntentId: null,
    isPublic: false,
    generationTimeMs: null,
    totalCostUsd: null,
    aiModelVersions: null,
    generatedDegraded: false,
    errorMessage: null,
    retryCount: 0,
    failedStep: null,
    deletedAt: null,
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
    ...overrides,
  };
}

describe('AgentService', () => {
  let service: AgentService;
  let prisma: MockPrisma;
  let mockPdfStorage: { savePreviewPdf: ReturnType<typeof vi.fn> };
  let mockImageAssetStorage: {
    saveImageAsset: ReturnType<typeof vi.fn>;
    getImageAsset: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    prisma = createMockPrisma();
    mockPdfStorage = { savePreviewPdf: vi.fn() };
    mockImageAssetStorage = {
      saveImageAsset: vi.fn(),
      getImageAsset: vi.fn().mockResolvedValue(undefined),
    };
    service = new AgentService(
      prisma as never,
      mockPdfStorage as unknown as PdfStorage,
      mockImageAssetStorage as unknown as ImageAssetStorage,
      new MockStoryGenerationProvider(),
      new MockImageGenerationProvider(),
    );
    vi.mocked(renderStorybookPdf).mockResolvedValue(Buffer.from('%PDF-1.4 mock'));
    mockPdfStorage.savePreviewPdf.mockResolvedValue({
      url: '/files/books/b-1/storybook.pdf',
      path: '/api/tmp/books/b-1/storybook.pdf',
    });
  });

  describe('startBookGeneration', () => {
    function setupMocks(bookOverrides: Partial<Book> = {}) {
      const layoutBook = makeBook({ status: 'layout' as Book['status'] });
      const completedBook = makeBook({
        status: 'complete' as Book['status'],
        previewPdfUrl: '/files/books/b-1/storybook.pdf',
        ...bookOverrides,
      });
      prisma.book.update.mockResolvedValueOnce(layoutBook).mockResolvedValueOnce(completedBook);
      prisma.agentLog.createMany.mockResolvedValue({ count: 9 });
      return completedBook;
    }

    it('advances book status to layout', async () => {
      const book = makeBook();
      setupMocks();

      await service.startBookGeneration(book);

      expect(prisma.book.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'b-1' },
          data: expect.objectContaining({ status: 'layout' }),
        }),
      );
    });

    it('returns the updated book', async () => {
      const book = makeBook();
      const updatedBook = setupMocks();

      const result = await service.startBookGeneration(book);

      expect(result).toBe(updatedBook);
    });

    it('stores a characterCard derived from the book fields', async () => {
      const book = makeBook({ childName: 'Mia', childAge: 5 });
      setupMocks();

      await service.startBookGeneration(book);

      const updateArg = prisma.book.update.mock.calls[0]?.[0];
      const card = updateArg?.data?.characterCard as Record<string, unknown>;
      expect(card).toBeDefined();
      expect(card?.name).toBe('Mia');
      expect(card?.age).toBe(5);
      expect(typeof card?.visualAnchor).toBe('string');
    });

    it('stores a storyPlan derived from the book fields', async () => {
      const book = makeBook({ childName: 'Mia', theme: 'friendship' });
      setupMocks();

      await service.startBookGeneration(book);

      const updateArg = prisma.book.update.mock.calls[0]?.[0];
      const plan = updateArg?.data?.storyPlan as Record<string, unknown>;
      expect(plan).toBeDefined();
      expect(plan?.theme).toBe('friendship');
      expect(Array.isArray(plan?.chapters)).toBe(true);
      expect((plan?.chapters as unknown[]).length).toBe(3);
    });

    it('stores storyPlan.pages with 2 pages per chapter', async () => {
      const book = makeBook({ childName: 'Mia', theme: 'friendship' });
      setupMocks();

      await service.startBookGeneration(book);

      const updateArg = prisma.book.update.mock.calls[0]?.[0];
      const plan = updateArg?.data?.storyPlan as Record<string, unknown>;
      const chapters = plan?.chapters as unknown[];
      const pages = plan?.pages as Array<Record<string, unknown>>;
      expect(Array.isArray(pages)).toBe(true);
      expect(pages.length).toBe(chapters.length * 2);
    });

    it("honors the book's persisted pageCount when generating the storyPlan (Phase 4A)", async () => {
      const book = makeBook({ childName: 'Mia', theme: 'friendship', pageCount: 4 });
      setupMocks();

      await service.startBookGeneration(book);

      const updateArg = prisma.book.update.mock.calls[0]?.[0];
      const plan = updateArg?.data?.storyPlan as Record<string, unknown>;
      const pages = plan?.pages as Array<Record<string, unknown>>;
      expect(pages.length).toBe(4);
    });

    it('defaults to 6 pages when the book has no persisted pageCount', async () => {
      const book = makeBook({ childName: 'Mia', theme: 'friendship', pageCount: null });
      setupMocks();

      await service.startBookGeneration(book);

      const updateArg = prisma.book.update.mock.calls[0]?.[0];
      const plan = updateArg?.data?.storyPlan as Record<string, unknown>;
      const pages = plan?.pages as Array<Record<string, unknown>>;
      expect(pages.length).toBe(6);
    });

    it("uses the book's persisted educationalMessage as the storyPlan.educationalMessage (Phase 4A)", async () => {
      const book = makeBook({
        childName: 'Mia',
        theme: 'friendship',
        educationalMessage: 'It is okay to make mistakes',
      });
      setupMocks();

      await service.startBookGeneration(book);

      const updateArg = prisma.book.update.mock.calls[0]?.[0];
      const plan = updateArg?.data?.storyPlan as Record<string, unknown>;
      expect(plan?.educationalMessage).toBe('It is okay to make mistakes');
    });

    it('assigns globally incrementing pageNumbers starting from 1', async () => {
      const book = makeBook();
      setupMocks();

      await service.startBookGeneration(book);

      const updateArg = prisma.book.update.mock.calls[0]?.[0];
      const plan = updateArg?.data?.storyPlan as Record<string, unknown>;
      const pages = plan?.pages as Array<Record<string, unknown>>;
      const pageNumbers = pages.map((p) => p.pageNumber as number);
      expect(pageNumbers[0]).toBe(1);
      for (let i = 1; i < pageNumbers.length; i++) {
        expect(pageNumbers[i]).toBe(pageNumbers[i - 1]! + 1);
      }
    });

    it('sets chapterIndex to the chapter position', async () => {
      const book = makeBook();
      setupMocks();

      await service.startBookGeneration(book);

      const updateArg = prisma.book.update.mock.calls[0]?.[0];
      const plan = updateArg?.data?.storyPlan as Record<string, unknown>;
      const pages = plan?.pages as Array<Record<string, unknown>>;
      // pages 0 and 1 → chapterIndex 0; pages 2 and 3 → chapterIndex 1; etc.
      expect(pages[0]?.chapterIndex).toBe(0);
      expect(pages[1]?.chapterIndex).toBe(0);
      expect(pages[2]?.chapterIndex).toBe(1);
      expect(pages[3]?.chapterIndex).toBe(1);
    });

    it('each page includes required fields', async () => {
      const book = makeBook();
      setupMocks();

      await service.startBookGeneration(book);

      const updateArg = prisma.book.update.mock.calls[0]?.[0];
      const plan = updateArg?.data?.storyPlan as Record<string, unknown>;
      const pages = plan?.pages as Array<Record<string, unknown>>;
      for (const page of pages) {
        expect(typeof page.pageNumber).toBe('number');
        expect(typeof page.chapterIndex).toBe('number');
        expect(typeof page.title).toBe('string');
        expect(typeof page.sceneDescription).toBe('string');
        expect(typeof page.narration).toBe('string');
        expect(typeof page.illustrationPrompt).toBe('string');
        expect(typeof page.learningGoal).toBe('string');
      }
    });

    it('stores storyText on every page and it is non-empty', async () => {
      const book = makeBook({ childName: 'Mia', theme: 'friendship' });
      setupMocks();

      await service.startBookGeneration(book);

      const updateArg = prisma.book.update.mock.calls[0]?.[0];
      const plan = updateArg?.data?.storyPlan as Record<string, unknown>;
      const pages = plan?.pages as Array<Record<string, unknown>>;
      for (const page of pages) {
        expect(typeof page.storyText).toBe('string');
        expect((page.storyText as string).length).toBeGreaterThan(0);
      }
    });

    it('sets book title from the generated story plan', async () => {
      const book = makeBook({ childName: 'Mia', theme: 'friendship' });
      setupMocks();

      await service.startBookGeneration(book);

      const updateArg = prisma.book.update.mock.calls[0]?.[0];
      expect(typeof updateArg?.data?.title).toBe('string');
      expect(updateArg?.data?.title).toContain('Mia');
    });

    it('writes nine AgentLog records all sharing the same traceId', async () => {
      const book = makeBook();
      setupMocks();

      await service.startBookGeneration(book);

      expect(prisma.agentLog.createMany).toHaveBeenCalledOnce();
      const createManyArg = prisma.agentLog.createMany.mock.calls[0]?.[0];
      const entries = createManyArg?.data as Array<Record<string, unknown>>;
      expect(entries).toHaveLength(9);
      expect(entries[0]?.step).toBe('char_build');
      expect(entries[1]?.step).toBe('story_plan');
      expect(entries[2]?.step).toBe('page_plan');
      expect(entries[3]?.step).toBe('story_draft');
      expect(entries[4]?.step).toBe('illust_plan');
      expect(entries[5]?.step).toBe('preview_ready');
      expect(entries[6]?.step).toBe('image_gen');
      expect(entries[7]?.step).toBe('layout');
      expect(entries[8]?.step).toBe('pdf_render');
      const traceId = entries[0]?.traceId;
      expect(typeof traceId).toBe('string');
      for (const entry of entries) {
        expect(entry.traceId).toBe(traceId);
      }
    });

    it('stores illustration on every page', async () => {
      const book = makeBook();
      setupMocks();

      await service.startBookGeneration(book);

      const updateArg = prisma.book.update.mock.calls[0]?.[0];
      const plan = updateArg?.data?.storyPlan as Record<string, unknown>;
      const pages = plan?.pages as Array<Record<string, unknown>>;
      for (const page of pages) {
        expect(page.illustration).toBeDefined();
        expect(page.illustration).not.toBeNull();
      }
    });

    it('each page illustration has a non-empty prompt and negativePrompt', async () => {
      const book = makeBook({ childName: 'Mia', theme: 'friendship' });
      setupMocks();

      await service.startBookGeneration(book);

      const updateArg = prisma.book.update.mock.calls[0]?.[0];
      const plan = updateArg?.data?.storyPlan as Record<string, unknown>;
      const pages = plan?.pages as Array<Record<string, unknown>>;
      for (const page of pages) {
        const illust = page.illustration as Record<string, unknown>;
        expect(typeof illust.prompt).toBe('string');
        expect((illust.prompt as string).length).toBeGreaterThan(0);
        expect(typeof illust.negativePrompt).toBe('string');
        expect((illust.negativePrompt as string).length).toBeGreaterThan(0);
      }
    });

    it('illustration style is stable across all pages', async () => {
      const book = makeBook();
      setupMocks();

      await service.startBookGeneration(book);

      const updateArg = prisma.book.update.mock.calls[0]?.[0];
      const plan = updateArg?.data?.storyPlan as Record<string, unknown>;
      const pages = plan?.pages as Array<Record<string, unknown>>;
      const styles = pages.map((p) => (p.illustration as Record<string, unknown>).style);
      const firstStyle = styles[0];
      for (const s of styles) {
        expect(s).toBe(firstStyle);
      }
    });

    it('illustration aspectRatio is stable across all pages', async () => {
      const book = makeBook();
      setupMocks();

      await service.startBookGeneration(book);

      const updateArg = prisma.book.update.mock.calls[0]?.[0];
      const plan = updateArg?.data?.storyPlan as Record<string, unknown>;
      const pages = plan?.pages as Array<Record<string, unknown>>;
      const ratios = pages.map((p) => (p.illustration as Record<string, unknown>).aspectRatio);
      const firstRatio = ratios[0];
      for (const r of ratios) {
        expect(r).toBe(firstRatio);
      }
    });

    it('uses book.childName and theme for deterministic output', async () => {
      const book = makeBook({ childName: 'Leo', theme: 'courage' });
      setupMocks();

      await service.startBookGeneration(book);

      const updateArg = prisma.book.update.mock.calls[0]?.[0];
      const card = updateArg?.data?.characterCard as Record<string, unknown>;
      const plan = updateArg?.data?.storyPlan as Record<string, unknown>;
      expect(card?.name).toBe('Leo');
      expect(plan?.theme).toBe('courage');
    });

    it('stores bookPreview with a non-empty title', async () => {
      const book = makeBook({ childName: 'Mia', theme: 'friendship' });
      setupMocks();

      await service.startBookGeneration(book);

      const updateArg = prisma.book.update.mock.calls[0]?.[0];
      const preview = updateArg?.data?.bookPreview as Record<string, unknown>;
      expect(preview).toBeDefined();
      expect(typeof preview?.title).toBe('string');
      expect((preview?.title as string).length).toBeGreaterThan(0);
    });

    it('stores bookPreview with a cover', async () => {
      const book = makeBook({ childName: 'Mia', theme: 'friendship' });
      setupMocks();

      await service.startBookGeneration(book);

      const updateArg = prisma.book.update.mock.calls[0]?.[0];
      const preview = updateArg?.data?.bookPreview as Record<string, unknown>;
      expect(preview?.cover).toBeDefined();
      const cover = preview?.cover as Record<string, unknown>;
      expect(typeof cover?.title).toBe('string');
      expect(typeof cover?.illustrationPrompt).toBe('string');
      expect(cover?.childName).toBe('Mia');
    });

    it('bookPreview.pages length equals storyPlan.pages length', async () => {
      const book = makeBook({ childName: 'Mia', theme: 'friendship' });
      setupMocks();

      await service.startBookGeneration(book);

      const updateArg = prisma.book.update.mock.calls[0]?.[0];
      const plan = updateArg?.data?.storyPlan as Record<string, unknown>;
      const preview = updateArg?.data?.bookPreview as Record<string, unknown>;
      const storyPages = plan?.pages as unknown[];
      const previewPages = preview?.pages as unknown[];
      expect(previewPages.length).toBe(storyPages.length);
    });

    it('every preview page has text and illustrationPrompt', async () => {
      const book = makeBook({ childName: 'Mia', theme: 'friendship' });
      setupMocks();

      await service.startBookGeneration(book);

      const updateArg = prisma.book.update.mock.calls[0]?.[0];
      const preview = updateArg?.data?.bookPreview as Record<string, unknown>;
      const pages = preview?.pages as Array<Record<string, unknown>>;
      for (const page of pages) {
        expect(typeof page.text).toBe('string');
        expect((page.text as string).length).toBeGreaterThan(0);
        expect(typeof page.illustrationPrompt).toBe('string');
        expect((page.illustrationPrompt as string).length).toBeGreaterThan(0);
      }
    });

    it('bookPreview.metadata.totalPages equals bookPreview.pages.length', async () => {
      const book = makeBook({ childName: 'Mia', theme: 'friendship' });
      setupMocks();

      await service.startBookGeneration(book);

      const updateArg = prisma.book.update.mock.calls[0]?.[0];
      const preview = updateArg?.data?.bookPreview as Record<string, unknown>;
      const pages = preview?.pages as unknown[];
      const metadata = preview?.metadata as Record<string, unknown>;
      expect(metadata?.totalPages).toBe(pages.length);
    });

    it('storyText remains present on every page after buildBookPreview', async () => {
      const book = makeBook({ childName: 'Mia', theme: 'friendship' });
      setupMocks();

      await service.startBookGeneration(book);

      const updateArg = prisma.book.update.mock.calls[0]?.[0];
      const plan = updateArg?.data?.storyPlan as Record<string, unknown>;
      const pages = plan?.pages as Array<Record<string, unknown>>;
      for (const page of pages) {
        expect(typeof page.storyText).toBe('string');
        expect((page.storyText as string).length).toBeGreaterThan(0);
      }
    });

    it('illustration remains present on every page after buildBookPreview', async () => {
      const book = makeBook({ childName: 'Mia', theme: 'friendship' });
      setupMocks();

      await service.startBookGeneration(book);

      const updateArg = prisma.book.update.mock.calls[0]?.[0];
      const plan = updateArg?.data?.storyPlan as Record<string, unknown>;
      const pages = plan?.pages as Array<Record<string, unknown>>;
      for (const page of pages) {
        expect(page.illustration).toBeDefined();
        expect(page.illustration).not.toBeNull();
      }
    });

    // ── Phase 2G: Image generation result ────────────────────────────────────

    it('stores imageGenerationResult in the book update', async () => {
      const book = makeBook();
      setupMocks();

      await service.startBookGeneration(book);

      const updateArg = prisma.book.update.mock.calls[0]?.[0];
      const result = updateArg?.data?.imageGenerationResult as Record<string, unknown>;
      expect(result).toBeDefined();
      expect(result).not.toBeNull();
    });

    it('imageGenerationResult provider is local_mock', async () => {
      const book = makeBook();
      setupMocks();

      await service.startBookGeneration(book);

      const updateArg = prisma.book.update.mock.calls[0]?.[0];
      const result = updateArg?.data?.imageGenerationResult as Record<string, unknown>;
      expect(result.provider).toBe('local_mock');
      expect(result.status).toBe('complete');
    });

    it('imageGenerationResult.imageByteProvider reflects the injected ImageGenerationProvider, not the plan provider', async () => {
      const book = makeBook();
      setupMocks();

      await service.startBookGeneration(book);

      const updateArg = prisma.book.update.mock.calls[0]?.[0];
      const result = updateArg?.data?.imageGenerationResult as Record<string, unknown>;
      expect(result.imageByteProvider).toBe('mock');
    });

    it('imageGenerationResult includes a cover image', async () => {
      const book = makeBook({ childName: 'Mia', theme: 'friendship' });
      setupMocks();

      await service.startBookGeneration(book);

      const updateArg = prisma.book.update.mock.calls[0]?.[0];
      const result = updateArg?.data?.imageGenerationResult as Record<string, unknown>;
      const images = result.images as Array<Record<string, unknown>>;
      const coverImage = images.find((img) => img.kind === 'cover');
      expect(coverImage).toBeDefined();
      expect(coverImage?.imageUrl).toBe('/mock-images/b-1/cover.svg');
      expect(typeof coverImage?.altText).toBe('string');
    });

    it('imageGenerationResult includes one image per preview page', async () => {
      const book = makeBook({ childName: 'Mia', theme: 'friendship' });
      setupMocks();

      await service.startBookGeneration(book);

      const updateArg = prisma.book.update.mock.calls[0]?.[0];
      const preview = updateArg?.data?.bookPreview as Record<string, unknown>;
      const result = updateArg?.data?.imageGenerationResult as Record<string, unknown>;
      const previewPages = preview.pages as unknown[];
      const images = result.images as Array<Record<string, unknown>>;
      const pageImages = images.filter((img) => img.kind === 'page');
      expect(pageImages.length).toBe(previewPages.length);
    });

    it('imageGenerationResult includes a back cover image', async () => {
      const book = makeBook({ childName: 'Mia', theme: 'friendship' });
      setupMocks();

      await service.startBookGeneration(book);

      const updateArg = prisma.book.update.mock.calls[0]?.[0];
      const result = updateArg?.data?.imageGenerationResult as Record<string, unknown>;
      const images = result.images as Array<Record<string, unknown>>;
      const backCoverImage = images.find((img) => img.kind === 'back_cover');
      expect(backCoverImage).toBeDefined();
      expect(backCoverImage?.imageUrl).toBe('/mock-images/b-1/back-cover.svg');
    });

    it('image URLs are deterministic and stable across runs for the same bookId', async () => {
      const book = makeBook({ childName: 'Mia', theme: 'friendship' });
      setupMocks();

      await service.startBookGeneration(book);

      const updateArg = prisma.book.update.mock.calls[0]?.[0];
      const result = updateArg?.data?.imageGenerationResult as Record<string, unknown>;
      const images = result.images as Array<Record<string, unknown>>;
      for (const img of images) {
        expect((img.imageUrl as string).startsWith('/mock-images/b-1/')).toBe(true);
      }
    });

    it('page image URLs embed the page number', async () => {
      const book = makeBook({ childName: 'Mia', theme: 'friendship' });
      setupMocks();

      await service.startBookGeneration(book);

      const updateArg = prisma.book.update.mock.calls[0]?.[0];
      const result = updateArg?.data?.imageGenerationResult as Record<string, unknown>;
      const images = result.images as Array<Record<string, unknown>>;
      const pageImages = images.filter((img) => img.kind === 'page') as Array<
        Record<string, unknown>
      >;
      for (const img of pageImages) {
        const pageNum = img.pageNumber as number;
        expect(img.imageUrl).toBe(`/mock-images/b-1/page-${pageNum}.svg`);
      }
    });

    it('image seeds are stable and derived from bookId', async () => {
      const book = makeBook();
      setupMocks();

      await service.startBookGeneration(book);

      const updateArg = prisma.book.update.mock.calls[0]?.[0];
      const result = updateArg?.data?.imageGenerationResult as Record<string, unknown>;
      const images = result.images as Array<Record<string, unknown>>;
      for (const img of images) {
        expect((img.seed as string).startsWith('b-1:')).toBe(true);
      }
    });

    it('imageGenerationResult is deterministic for the same input', async () => {
      const book = makeBook({ childName: 'Mia', theme: 'friendship' });
      setupMocks();

      await service.startBookGeneration(book);

      prisma.book.update.mockClear();
      prisma.agentLog.createMany.mockClear();
      setupMocks();

      await service.startBookGeneration(book);

      const firstArg = prisma.book.update.mock.calls[0]?.[0];
      const firstResult = firstArg?.data?.imageGenerationResult as Record<string, unknown>;
      expect(firstResult.provider).toBe('local_mock');
      expect(firstResult.status).toBe('complete');
    });

    it('bookPreview is still stored alongside imageGenerationResult', async () => {
      const book = makeBook({ childName: 'Mia', theme: 'friendship' });
      setupMocks();

      await service.startBookGeneration(book);

      const updateArg = prisma.book.update.mock.calls[0]?.[0];
      const preview = updateArg?.data?.bookPreview as Record<string, unknown>;
      expect(preview).toBeDefined();
      expect(typeof preview?.title).toBe('string');
    });

    // ── Phase 2W: Mock local image producer wiring ────────────────────────────

    it('saves a mock image asset for every generated image entry', async () => {
      const book = makeBook({ childName: 'Mia', theme: 'friendship' });
      setupMocks();

      await service.startBookGeneration(book);

      const updateArg = prisma.book.update.mock.calls[0]?.[0];
      const result = updateArg?.data?.imageGenerationResult as Record<string, unknown>;
      const images = result.images as Array<Record<string, unknown>>;
      expect(mockImageAssetStorage.saveImageAsset).toHaveBeenCalledTimes(images.length);
    });

    it('saves each mock image asset with a non-empty PNG buffer under the matching key', async () => {
      const book = makeBook();
      setupMocks();

      await service.startBookGeneration(book);

      const coverCall = mockImageAssetStorage.saveImageAsset.mock.calls.find(
        (call) => call[0] === 'b-1/cover',
      );
      expect(coverCall).toBeDefined();
      const [, buffer, contentType] = coverCall!;
      expect(Buffer.isBuffer(buffer)).toBe(true);
      expect((buffer as Buffer).length).toBeGreaterThan(0);
      expect(contentType).toBe('image/png');
    });

    it('saves mock image assets before rendering the PDF so saved bytes can be resolved', async () => {
      const book = makeBook();
      setupMocks();

      await service.startBookGeneration(book);

      const saveOrder = mockImageAssetStorage.saveImageAsset.mock.invocationCallOrder[0]!;
      const renderOrder = vi.mocked(renderStorybookPdf).mock.invocationCallOrder[0]!;
      expect(saveOrder).toBeLessThan(renderOrder);
    });

    it('still completes generation when a mock image save fails', async () => {
      const book = makeBook();
      setupMocks();
      mockImageAssetStorage.saveImageAsset.mockRejectedValueOnce(new Error('disk full'));

      const result = await service.startBookGeneration(book);

      expect(result.status).toBe('complete');
      expect(renderStorybookPdf).toHaveBeenCalledOnce();
    });

    it('logs a warning and continues saving other images when one mock image save fails', async () => {
      const book = makeBook();
      setupMocks();
      const warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      mockImageAssetStorage.saveImageAsset.mockRejectedValueOnce(new Error('disk full'));

      await service.startBookGeneration(book);

      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Image generation/save failed'));
      const updateArg = prisma.book.update.mock.calls[0]?.[0];
      const result = updateArg?.data?.imageGenerationResult as Record<string, unknown>;
      const images = result.images as Array<Record<string, unknown>>;
      expect(mockImageAssetStorage.saveImageAsset).toHaveBeenCalledTimes(images.length);
      warnSpy.mockRestore();
    });

    // ── Phase 3C / partial-failure tolerance: ImageGenerationProvider boundary ─

    describe('when the image generation provider fails for some or all images', () => {
      function makePartiallyFailingImageService(shouldFail: (entryId: string) => boolean) {
        const failingImageProvider: ImageGenerationProvider = {
          generateImage: vi.fn().mockImplementation(async ({ entry }) => {
            if (shouldFail(entry.id)) {
              throw new Error(`OpenAI image request failed for ${entry.id}`);
            }
            return { buffer: Buffer.from('fake-png'), contentType: 'image/png' as const };
          }),
        };
        return new AgentService(
          prisma as never,
          mockPdfStorage as unknown as PdfStorage,
          mockImageAssetStorage as unknown as ImageAssetStorage,
          new MockStoryGenerationProvider(),
          failingImageProvider,
        );
      }

      it('still completes generation and renders the PDF when every image fails', async () => {
        const book = makeBook();
        setupMocks();
        const warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
        const failingService = makePartiallyFailingImageService(() => true);

        const result = await failingService.startBookGeneration(book);

        expect(result.status).toBe('complete');
        expect(renderStorybookPdf).toHaveBeenCalledOnce();
        expect(mockPdfStorage.savePreviewPdf).toHaveBeenCalledOnce();
        expect(mockImageAssetStorage.saveImageAsset).not.toHaveBeenCalled();
        warnSpy.mockRestore();
      });

      it('saves bytes only for entries that succeeded, leaving the rest as placeholders', async () => {
        const book = makeBook();
        setupMocks();
        const failingService = makePartiallyFailingImageService((id) => id === 'b-1-cover');

        await failingService.startBookGeneration(book);

        expect(mockImageAssetStorage.saveImageAsset).not.toHaveBeenCalledWith(
          'b-1/cover',
          expect.anything(),
          expect.anything(),
        );
        const pageOneCall = mockImageAssetStorage.saveImageAsset.mock.calls.find(
          (call) => call[0] === 'b-1/page-1',
        );
        expect(pageOneCall).toBeDefined();
      });

      it('records generatedImageCount/failedImageCount/lastImageError on imageGenerationResult', async () => {
        const book = makeBook();
        setupMocks();
        const failingService = makePartiallyFailingImageService((id) => id === 'b-1-cover');

        await failingService.startBookGeneration(book);

        const updateArg = prisma.book.update.mock.calls[0]?.[0];
        const result = updateArg?.data?.imageGenerationResult as Record<string, unknown>;
        const images = result.images as Array<Record<string, unknown>>;
        expect(result.failedImageCount).toBe(1);
        expect(result.generatedImageCount).toBe(images.length - 1);
        expect(result.lastImageError).toContain('b-1-cover');
      });

      it('does not mark the book failed, and the image_gen AgentLog row stays status success with a safe summary error', async () => {
        const book = makeBook();
        setupMocks();
        const failingService = makePartiallyFailingImageService(() => true);

        const result = await failingService.startBookGeneration(book);

        expect(result.status).not.toBe('failed');
        expect(prisma.agentLog.createMany).toHaveBeenCalledOnce();
        const entries = prisma.agentLog.createMany.mock.calls[0]?.[0]?.data as Array<
          Record<string, unknown>
        >;
        const imageGenEntry = entries.find((e) => e.step === 'image_gen');
        expect(imageGenEntry?.status).toBe('success');
        expect(imageGenEntry?.error).toEqual(expect.stringContaining('failed to generate'));
      });
    });

    // ── MAX_GENERATED_IMAGES_PER_BOOK cost cap ────────────────────────────────

    describe('MAX_GENERATED_IMAGES_PER_BOOK cost cap (real provider only)', () => {
      function makeRealImageProvider() {
        return {
          providerName: 'openai' as const,
          modelName: 'gpt-image-1',
          generateImage: vi.fn().mockResolvedValue({
            buffer: Buffer.from('fake-png'),
            contentType: 'image/png' as const,
          }),
        };
      }

      async function withMaxGeneratedImagesEnv(
        value: string | undefined,
        run: () => Promise<void>,
      ): Promise<void> {
        const original = process.env.MAX_GENERATED_IMAGES_PER_BOOK;
        if (value === undefined) delete process.env.MAX_GENERATED_IMAGES_PER_BOOK;
        else process.env.MAX_GENERATED_IMAGES_PER_BOOK = value;
        try {
          await run();
        } finally {
          if (original === undefined) delete process.env.MAX_GENERATED_IMAGES_PER_BOOK;
          else process.env.MAX_GENERATED_IMAGES_PER_BOOK = original;
        }
      }

      it('caps real generation calls to MAX_GENERATED_IMAGES_PER_BOOK and leaves the rest as placeholders', async () => {
        await withMaxGeneratedImagesEnv('2', async () => {
          const book = makeBook();
          const realProvider = makeRealImageProvider();
          const realService = new AgentService(
            prisma as never,
            mockPdfStorage as unknown as PdfStorage,
            mockImageAssetStorage as unknown as ImageAssetStorage,
            new MockStoryGenerationProvider(),
            realProvider,
          );
          setupMocks();

          const result = await realService.startBookGeneration(book);

          expect(result.status).not.toBe('failed');
          expect(realProvider.generateImage).toHaveBeenCalledTimes(2);
          expect(mockImageAssetStorage.saveImageAsset).toHaveBeenCalledTimes(2);

          const updateArg = prisma.book.update.mock.calls[0]?.[0];
          const imageGenerationResult = updateArg?.data?.imageGenerationResult as Record<
            string,
            unknown
          >;
          expect(imageGenerationResult.imageByteProvider).toBe('openai');
          expect(imageGenerationResult.generatedImageCount).toBe(2);
          expect(imageGenerationResult.failedImageCount).toBe(0);
        });
      });

      it('does not cap the free mock provider', async () => {
        await withMaxGeneratedImagesEnv('2', async () => {
          const book = makeBook();
          setupMocks();

          await service.startBookGeneration(book);

          const updateArg = prisma.book.update.mock.calls[0]?.[0];
          const result = updateArg?.data?.imageGenerationResult as Record<string, unknown>;
          const images = result.images as Array<Record<string, unknown>>;
          expect(images.length).toBeGreaterThan(2);
          expect(mockImageAssetStorage.saveImageAsset).toHaveBeenCalledTimes(images.length);
        });
      });

      it('defaults to 3 real images when MAX_GENERATED_IMAGES_PER_BOOK is unset', async () => {
        await withMaxGeneratedImagesEnv(undefined, async () => {
          const book = makeBook();
          const realProvider = makeRealImageProvider();
          const realService = new AgentService(
            prisma as never,
            mockPdfStorage as unknown as PdfStorage,
            mockImageAssetStorage as unknown as ImageAssetStorage,
            new MockStoryGenerationProvider(),
            realProvider,
          );
          setupMocks();

          await realService.startBookGeneration(book);

          expect(realProvider.generateImage).toHaveBeenCalledTimes(3);
        });
      });
    });

    // ── Phase 2H: Layout engine ───────────────────────────────────────────────

    it('stores bookLayout in the book update', async () => {
      const book = makeBook();
      setupMocks();

      await service.startBookGeneration(book);

      const updateArg = prisma.book.update.mock.calls[0]?.[0];
      const layout = updateArg?.data?.bookLayout as Record<string, unknown>;
      expect(layout).toBeDefined();
      expect(layout).not.toBeNull();
    });

    it('bookLayout.status is complete', async () => {
      const book = makeBook();
      setupMocks();

      await service.startBookGeneration(book);

      const updateArg = prisma.book.update.mock.calls[0]?.[0];
      const layout = updateArg?.data?.bookLayout as Record<string, unknown>;
      expect(layout.status).toBe('complete');
    });

    it('bookLayout.trimSize is square_8x8', async () => {
      const book = makeBook();
      setupMocks();

      await service.startBookGeneration(book);

      const updateArg = prisma.book.update.mock.calls[0]?.[0];
      const layout = updateArg?.data?.bookLayout as Record<string, unknown>;
      expect(layout.trimSize).toBe('square_8x8');
    });

    it('bookLayout.entries contains a cover entry', async () => {
      const book = makeBook({ childName: 'Mia', theme: 'friendship' });
      setupMocks();

      await service.startBookGeneration(book);

      const updateArg = prisma.book.update.mock.calls[0]?.[0];
      const layout = updateArg?.data?.bookLayout as Record<string, unknown>;
      const entries = layout.entries as Array<Record<string, unknown>>;
      const coverEntry = entries.find((e) => e.kind === 'cover');
      expect(coverEntry).toBeDefined();
      expect(coverEntry?.template).toBe('cover_full_bleed');
    });

    it('bookLayout.entries contains one entry per preview page', async () => {
      const book = makeBook({ childName: 'Mia', theme: 'friendship' });
      setupMocks();

      await service.startBookGeneration(book);

      const updateArg = prisma.book.update.mock.calls[0]?.[0];
      const preview = updateArg?.data?.bookPreview as Record<string, unknown>;
      const layout = updateArg?.data?.bookLayout as Record<string, unknown>;
      const previewPages = preview.pages as unknown[];
      const entries = layout.entries as Array<Record<string, unknown>>;
      const pageEntries = entries.filter((e) => e.kind === 'page');
      expect(pageEntries.length).toBe(previewPages.length);
    });

    it('bookLayout.entries contains a back_cover entry', async () => {
      const book = makeBook({ childName: 'Mia', theme: 'friendship' });
      setupMocks();

      await service.startBookGeneration(book);

      const updateArg = prisma.book.update.mock.calls[0]?.[0];
      const layout = updateArg?.data?.bookLayout as Record<string, unknown>;
      const entries = layout.entries as Array<Record<string, unknown>>;
      const backEntry = entries.find((e) => e.kind === 'back_cover');
      expect(backEntry).toBeDefined();
      expect(backEntry?.template).toBe('back_cover_summary');
    });

    it('every layout entry has canvas 2400x2400px (print-ready)', async () => {
      const book = makeBook();
      setupMocks();

      await service.startBookGeneration(book);

      const updateArg = prisma.book.update.mock.calls[0]?.[0];
      const layout = updateArg?.data?.bookLayout as Record<string, unknown>;
      const entries = layout.entries as Array<Record<string, unknown>>;
      for (const entry of entries) {
        const canvas = entry.canvas as Record<string, unknown>;
        expect(canvas.width).toBe(2400);
        expect(canvas.height).toBe(2400);
        expect(canvas.unit).toBe('px');
      }
    });

    it('every layout entry has trimSize square_8x8', async () => {
      const book = makeBook();
      setupMocks();

      await service.startBookGeneration(book);

      const updateArg = prisma.book.update.mock.calls[0]?.[0];
      const layout = updateArg?.data?.bookLayout as Record<string, unknown>;
      const entries = layout.entries as Array<Record<string, unknown>>;
      for (const entry of entries) {
        expect(entry.trimSize).toBe('square_8x8');
      }
    });

    it('page entries have deterministic templates cycling across three variants', async () => {
      const book = makeBook({ childName: 'Mia', theme: 'friendship' });
      setupMocks();

      await service.startBookGeneration(book);

      const updateArg = prisma.book.update.mock.calls[0]?.[0];
      const layout = updateArg?.data?.bookLayout as Record<string, unknown>;
      const entries = layout.entries as Array<Record<string, unknown>>;
      const pageEntries = entries.filter((e) => e.kind === 'page');
      const expectedTemplates = [
        'image_top_text_bottom',
        'text_left_image_right',
        'image_left_text_right',
      ];
      for (let i = 0; i < pageEntries.length; i++) {
        expect(pageEntries[i]?.template).toBe(expectedTemplates[i % expectedTemplates.length]);
      }
    });

    it('cover entry imageBlock.imageUrl matches the cover image from imageGenerationResult', async () => {
      const book = makeBook({ childName: 'Mia', theme: 'friendship' });
      setupMocks();

      await service.startBookGeneration(book);

      const updateArg = prisma.book.update.mock.calls[0]?.[0];
      const layout = updateArg?.data?.bookLayout as Record<string, unknown>;
      const entries = layout.entries as Array<Record<string, unknown>>;
      const coverEntry = entries.find((e) => e.kind === 'cover');
      const imageBlock = coverEntry?.imageBlock as Record<string, unknown>;
      expect(imageBlock?.imageUrl).toBe('/mock-images/b-1/cover.svg');
    });

    it('bookLayout.metadata.title matches bookPreview.title', async () => {
      const book = makeBook({ childName: 'Mia', theme: 'friendship' });
      setupMocks();

      await service.startBookGeneration(book);

      const updateArg = prisma.book.update.mock.calls[0]?.[0];
      const preview = updateArg?.data?.bookPreview as Record<string, unknown>;
      const layout = updateArg?.data?.bookLayout as Record<string, unknown>;
      const meta = layout.metadata as Record<string, unknown>;
      expect(meta.title).toBe(preview.title);
    });

    it('bookLayout.metadata.childName equals the book childName', async () => {
      const book = makeBook({ childName: 'Mia', theme: 'friendship' });
      setupMocks();

      await service.startBookGeneration(book);

      const updateArg = prisma.book.update.mock.calls[0]?.[0];
      const layout = updateArg?.data?.bookLayout as Record<string, unknown>;
      const meta = layout.metadata as Record<string, unknown>;
      expect(meta.childName).toBe('Mia');
    });

    it('bookLayout is deterministic for the same input', async () => {
      const book = makeBook({ childName: 'Mia', theme: 'friendship' });
      setupMocks();
      await service.startBookGeneration(book);
      const firstArg = prisma.book.update.mock.calls[0]?.[0];
      const firstLayout = firstArg?.data?.bookLayout as Record<string, unknown>;
      const firstEntries = (firstLayout.entries as Array<Record<string, unknown>>).map((e) => e.id);

      prisma.book.update.mockClear();
      prisma.agentLog.createMany.mockClear();
      setupMocks();
      await service.startBookGeneration(book);
      const secondArg = prisma.book.update.mock.calls[0]?.[0];
      const secondLayout = secondArg?.data?.bookLayout as Record<string, unknown>;
      const secondEntries = (secondLayout.entries as Array<Record<string, unknown>>).map(
        (e) => e.id,
      );

      expect(secondEntries).toEqual(firstEntries);
    });

    // ── Phase 2J: PDF render step ─────────────────────────────────────────────

    it('calls renderStorybookPdf after layout is built', async () => {
      const book = makeBook();
      setupMocks();

      await service.startBookGeneration(book);

      expect(renderStorybookPdf).toHaveBeenCalledOnce();
    });

    it('calls pdfStorage.savePreviewPdf with the book id and the rendered buffer', async () => {
      const book = makeBook();
      setupMocks();
      const mockBuffer = Buffer.from('%PDF-1.4 mock');
      vi.mocked(renderStorybookPdf).mockResolvedValue(mockBuffer);

      await service.startBookGeneration(book);

      expect(mockPdfStorage.savePreviewPdf).toHaveBeenCalledWith('b-1', mockBuffer);
    });

    it('advances book status to complete on success', async () => {
      const book = makeBook();
      setupMocks();

      await service.startBookGeneration(book);

      const secondCallArg = prisma.book.update.mock.calls[1]?.[0];
      expect(secondCallArg?.data).toMatchObject({ status: 'complete' });
    });

    it('persists previewPdfUrl from storage result on the second update', async () => {
      const book = makeBook();
      setupMocks();

      await service.startBookGeneration(book);

      const secondCallArg = prisma.book.update.mock.calls[1]?.[0];
      expect(secondCallArg?.data?.previewPdfUrl).toBe('/files/books/b-1/storybook.pdf');
    });

    it('returns the completed book (result of the second update)', async () => {
      const book = makeBook();
      const completedBook = setupMocks();

      const result = await service.startBookGeneration(book);

      expect(result).toBe(completedBook);
    });

    it('pdf_render AgentLog entry has status success on happy path', async () => {
      const book = makeBook();
      setupMocks();

      await service.startBookGeneration(book);

      const entries = prisma.agentLog.createMany.mock.calls[0]?.[0]?.data as Array<
        Record<string, unknown>
      >;
      const pdfEntry = entries.find((e) => e.step === 'pdf_render');
      expect(pdfEntry?.status).toBe('success');
    });

    it('marks book as failed when renderStorybookPdf throws', async () => {
      const book = makeBook();
      setupMocks();
      vi.mocked(renderStorybookPdf).mockRejectedValue(new Error('PDF engine crashed'));
      // Second prisma update now returns a failed book — reset the mock chain
      const failedBook = makeBook({ status: 'failed' as Book['status'] });
      prisma.book.update.mockReset();
      prisma.book.update
        .mockResolvedValueOnce(makeBook({ status: 'layout' as Book['status'] }))
        .mockResolvedValueOnce(failedBook);

      await service.startBookGeneration(book);

      const secondCallArg = prisma.book.update.mock.calls[1]?.[0];
      expect(secondCallArg?.data?.status).toBe('failed');
    });

    it('does not set previewPdfUrl when PDF render fails', async () => {
      const book = makeBook();
      setupMocks();
      vi.mocked(renderStorybookPdf).mockRejectedValue(new Error('render error'));
      prisma.book.update.mockReset();
      prisma.book.update
        .mockResolvedValueOnce(makeBook({ status: 'layout' as Book['status'] }))
        .mockResolvedValueOnce(makeBook({ status: 'failed' as Book['status'] }));

      await service.startBookGeneration(book);

      const secondCallArg = prisma.book.update.mock.calls[1]?.[0];
      expect(secondCallArg?.data).not.toHaveProperty('previewPdfUrl');
    });

    it('persists errorMessage and failedStep when PDF render fails', async () => {
      const book = makeBook();
      setupMocks();
      vi.mocked(renderStorybookPdf).mockRejectedValue(new Error('PDFKit failure'));
      prisma.book.update.mockReset();
      prisma.book.update
        .mockResolvedValueOnce(makeBook({ status: 'layout' as Book['status'] }))
        .mockResolvedValueOnce(makeBook({ status: 'failed' as Book['status'] }));

      await service.startBookGeneration(book);

      const secondCallArg = prisma.book.update.mock.calls[1]?.[0];
      expect(secondCallArg?.data?.errorMessage).toBe('PDFKit failure');
      expect(secondCallArg?.data?.failedStep).toBe('pdf_render');
    });

    it('pdf_render AgentLog entry has status error when render fails', async () => {
      const book = makeBook();
      setupMocks();
      vi.mocked(renderStorybookPdf).mockRejectedValue(new Error('render error'));
      prisma.book.update.mockReset();
      prisma.book.update
        .mockResolvedValueOnce(makeBook({ status: 'layout' as Book['status'] }))
        .mockResolvedValueOnce(makeBook({ status: 'failed' as Book['status'] }));

      await service.startBookGeneration(book);

      const entries = prisma.agentLog.createMany.mock.calls[0]?.[0]?.data as Array<
        Record<string, unknown>
      >;
      const pdfEntry = entries.find((e) => e.step === 'pdf_render');
      expect(pdfEntry?.status).toBe('error');
      expect(typeof pdfEntry?.error).toBe('string');
    });

    it('does not mark book complete when PDF render fails', async () => {
      const book = makeBook();
      setupMocks();
      vi.mocked(renderStorybookPdf).mockRejectedValue(new Error('boom'));
      prisma.book.update.mockReset();
      prisma.book.update
        .mockResolvedValueOnce(makeBook({ status: 'layout' as Book['status'] }))
        .mockResolvedValueOnce(makeBook({ status: 'failed' as Book['status'] }));

      await service.startBookGeneration(book);

      const secondCallArg = prisma.book.update.mock.calls[1]?.[0];
      expect(secondCallArg?.data?.status).not.toBe('complete');
    });

    // ── Phase 2M: Storage failure ─────────────────────────────────────────────

    it('marks book as failed when pdfStorage.savePreviewPdf throws', async () => {
      const book = makeBook();
      setupMocks();
      mockPdfStorage.savePreviewPdf.mockRejectedValue(new Error('disk full'));
      prisma.book.update.mockReset();
      prisma.book.update
        .mockResolvedValueOnce(makeBook({ status: 'layout' as Book['status'] }))
        .mockResolvedValueOnce(makeBook({ status: 'failed' as Book['status'] }));

      await service.startBookGeneration(book);

      const secondCallArg = prisma.book.update.mock.calls[1]?.[0];
      expect(secondCallArg?.data?.status).toBe('failed');
    });

    it('does not mark book complete when storage fails', async () => {
      const book = makeBook();
      setupMocks();
      mockPdfStorage.savePreviewPdf.mockRejectedValue(new Error('storage error'));
      prisma.book.update.mockReset();
      prisma.book.update
        .mockResolvedValueOnce(makeBook({ status: 'layout' as Book['status'] }))
        .mockResolvedValueOnce(makeBook({ status: 'failed' as Book['status'] }));

      await service.startBookGeneration(book);

      const secondCallArg = prisma.book.update.mock.calls[1]?.[0];
      expect(secondCallArg?.data?.status).not.toBe('complete');
    });

    it('does not persist previewPdfUrl when storage fails', async () => {
      const book = makeBook();
      setupMocks();
      mockPdfStorage.savePreviewPdf.mockRejectedValue(new Error('storage error'));
      prisma.book.update.mockReset();
      prisma.book.update
        .mockResolvedValueOnce(makeBook({ status: 'layout' as Book['status'] }))
        .mockResolvedValueOnce(makeBook({ status: 'failed' as Book['status'] }));

      await service.startBookGeneration(book);

      const secondCallArg = prisma.book.update.mock.calls[1]?.[0];
      expect(secondCallArg?.data).not.toHaveProperty('previewPdfUrl');
    });

    it('persists errorMessage and failedStep when storage fails', async () => {
      const book = makeBook();
      setupMocks();
      mockPdfStorage.savePreviewPdf.mockRejectedValue(new Error('disk full'));
      prisma.book.update.mockReset();
      prisma.book.update
        .mockResolvedValueOnce(makeBook({ status: 'layout' as Book['status'] }))
        .mockResolvedValueOnce(makeBook({ status: 'failed' as Book['status'] }));

      await service.startBookGeneration(book);

      const secondCallArg = prisma.book.update.mock.calls[1]?.[0];
      expect(secondCallArg?.data?.errorMessage).toBe('disk full');
      expect(secondCallArg?.data?.failedStep).toBe('pdf_render');
    });

    it('pdf_render AgentLog entry has status error when storage fails', async () => {
      const book = makeBook();
      setupMocks();
      mockPdfStorage.savePreviewPdf.mockRejectedValue(new Error('write failed'));
      prisma.book.update.mockReset();
      prisma.book.update
        .mockResolvedValueOnce(makeBook({ status: 'layout' as Book['status'] }))
        .mockResolvedValueOnce(makeBook({ status: 'failed' as Book['status'] }));

      await service.startBookGeneration(book);

      const entries = prisma.agentLog.createMany.mock.calls[0]?.[0]?.data as Array<
        Record<string, unknown>
      >;
      const pdfEntry = entries.find((e) => e.step === 'pdf_render');
      expect(pdfEntry?.status).toBe('error');
      expect(pdfEntry?.error).toBe('write failed');
    });

    // ── Phase 3A: StoryGenerationProvider boundary ────────────────────────────

    describe('when the story generation provider fails', () => {
      function makeFailingService(errorMessage: string) {
        const failingProvider: StoryGenerationProvider = {
          generateStory: vi.fn().mockRejectedValue(new Error(errorMessage)),
        };
        return new AgentService(
          prisma as never,
          mockPdfStorage as unknown as PdfStorage,
          mockImageAssetStorage as unknown as ImageAssetStorage,
          failingProvider,
          new MockImageGenerationProvider(),
        );
      }

      it('marks the book as failed with the provider error message', async () => {
        const book = makeBook();
        const failedBook = makeBook({ status: 'failed' as Book['status'] });
        prisma.book.update.mockResolvedValueOnce(failedBook);
        prisma.agentLog.createMany.mockResolvedValue({ count: 1 });
        const failingService = makeFailingService('LLM provider unavailable');

        const result = await failingService.startBookGeneration(book);

        expect(result).toBe(failedBook);
        expect(prisma.book.update).toHaveBeenCalledWith({
          where: { id: 'b-1' },
          data: {
            status: 'failed',
            errorMessage: 'LLM provider unavailable',
            failedStep: 'story_plan',
            generationTimeMs: expect.any(Number),
            aiModelVersions: { story: 'unknown', image: 'mock' },
          },
        });
      });

      it('does not attempt to save image assets, build layout, or render a PDF', async () => {
        const book = makeBook();
        prisma.book.update.mockResolvedValueOnce(makeBook({ status: 'failed' as Book['status'] }));
        prisma.agentLog.createMany.mockResolvedValue({ count: 1 });
        const failingService = makeFailingService('boom');

        await failingService.startBookGeneration(book);

        expect(mockImageAssetStorage.saveImageAsset).not.toHaveBeenCalled();
        expect(renderStorybookPdf).not.toHaveBeenCalled();
        expect(mockPdfStorage.savePreviewPdf).not.toHaveBeenCalled();
        expect(prisma.book.update).toHaveBeenCalledOnce();
      });

      it('writes a single story_plan AgentLog entry with status error', async () => {
        const book = makeBook();
        prisma.book.update.mockResolvedValueOnce(makeBook({ status: 'failed' as Book['status'] }));
        prisma.agentLog.createMany.mockResolvedValue({ count: 1 });
        const failingService = makeFailingService('bad prompt');

        await failingService.startBookGeneration(book);

        expect(prisma.agentLog.createMany).toHaveBeenCalledOnce();
        const entries = prisma.agentLog.createMany.mock.calls[0]?.[0]?.data as Array<
          Record<string, unknown>
        >;
        expect(entries).toHaveLength(1);
        expect(entries[0]?.step).toBe('story_plan');
        expect(entries[0]?.status).toBe('error');
        expect(entries[0]?.error).toBe('bad prompt');
      });
    });

    describe('story generation provider integration', () => {
      it('calls storyGenerationProvider.generateStory with the book fields', async () => {
        const book = makeBook({ childName: 'Mia', childAge: 5, theme: 'friendship' });
        setupMocks();
        const generateStory = vi
          .fn()
          .mockImplementation((input) => new MockStoryGenerationProvider().generateStory(input));
        const spyingService = new AgentService(
          prisma as never,
          mockPdfStorage as unknown as PdfStorage,
          mockImageAssetStorage as unknown as ImageAssetStorage,
          { generateStory },
          new MockImageGenerationProvider(),
        );

        await spyingService.startBookGeneration(book);

        expect(generateStory).toHaveBeenCalledWith({
          bookId: 'b-1',
          childName: 'Mia',
          childAge: 5,
          theme: 'friendship',
          language: 'en',
        });
      });
    });

    // ── Phase 3E: generation diagnostics metadata ─────────────────────────────

    describe('generation diagnostics metadata', () => {
      it('records generationTimeMs and aiModelVersions on the final update when generation succeeds', async () => {
        const book = makeBook();
        setupMocks();

        await service.startBookGeneration(book);

        const finalUpdateArg = prisma.book.update.mock.calls[1]?.[0];
        expect(finalUpdateArg?.data?.generationTimeMs).toEqual(expect.any(Number));
        expect(finalUpdateArg?.data?.aiModelVersions).toEqual({ story: 'mock', image: 'mock' });
      });

      it('tags every AgentLog entry with provider/model from the injected providers', async () => {
        const book = makeBook();
        setupMocks();

        await service.startBookGeneration(book);

        const entries = prisma.agentLog.createMany.mock.calls[0]?.[0]?.data as Array<
          Record<string, unknown>
        >;
        const storyEntry = entries.find((e) => e.step === 'story_plan');
        const imageEntry = entries.find((e) => e.step === 'image_gen');
        expect(storyEntry?.provider).toBe('mock');
        expect(imageEntry?.provider).toBe('mock');
      });

      it('records durationMs on the story_plan, image_gen, layout, and pdf_render AgentLog entries', async () => {
        const book = makeBook();
        setupMocks();

        await service.startBookGeneration(book);

        const entries = prisma.agentLog.createMany.mock.calls[0]?.[0]?.data as Array<
          Record<string, unknown>
        >;
        for (const step of ['story_plan', 'image_gen', 'layout', 'pdf_render']) {
          const entry = entries.find((e) => e.step === step);
          expect(entry?.durationMs).toEqual(expect.any(Number));
        }
      });

      it('uses the real openai provider/model labels when injected', async () => {
        const book = makeBook();
        setupMocks();
        const openaiStoryProvider: StoryGenerationProvider = {
          providerName: 'openai',
          modelName: 'gpt-4o-mini',
          generateStory: (input) => new MockStoryGenerationProvider().generateStory(input),
        };
        const openaiService = new AgentService(
          prisma as never,
          mockPdfStorage as unknown as PdfStorage,
          mockImageAssetStorage as unknown as ImageAssetStorage,
          openaiStoryProvider,
          new MockImageGenerationProvider(),
        );

        await openaiService.startBookGeneration(book);

        const finalUpdateArg = prisma.book.update.mock.calls[1]?.[0];
        expect(finalUpdateArg?.data?.aiModelVersions).toEqual({
          story: 'gpt-4o-mini',
          image: 'mock',
        });
        const entries = prisma.agentLog.createMany.mock.calls[0]?.[0]?.data as Array<
          Record<string, unknown>
        >;
        const storyEntry = entries.find((e) => e.step === 'story_plan');
        expect(storyEntry?.provider).toBe('openai');
        expect(storyEntry?.model).toBe('gpt-4o-mini');
      });
    });

    // ── QA: Book Output QA & Renderer Stabilization phase ─────────────────────

    describe('language handling end-to-end', () => {
      it('produces a Russian bookLayout when the book language is "ru"', async () => {
        const book = makeBook({
          childName: 'Mia',
          theme: 'friendship',
          language: 'ru' as Book['language'],
        });
        setupMocks();

        await service.startBookGeneration(book);

        const updateArg = prisma.book.update.mock.calls[0]?.[0];
        const layout = updateArg?.data?.bookLayout as Record<string, unknown>;
        const entries = layout.entries as Array<Record<string, unknown>>;
        const pageEntry = entries.find((e) => e.kind === 'page');
        const textBlock = pageEntry?.textBlock as Record<string, unknown>;
        expect(textBlock?.text as string).toMatch(/[а-яА-ЯёЁ]/);
      });
    });

    describe('child name capitalization end-to-end', () => {
      it('never lowercases the leading letter of a capitalized childName in the rendered layout text', async () => {
        const book = makeBook({ childName: 'Maya', theme: 'friendship' });
        setupMocks();

        await service.startBookGeneration(book);

        const updateArg = prisma.book.update.mock.calls[0]?.[0];
        const layout = updateArg?.data?.bookLayout as Record<string, unknown>;
        const entries = layout.entries as Array<Record<string, unknown>>;
        for (const entry of entries) {
          const textBlock = entry.textBlock as Record<string, unknown> | undefined;
          if (textBlock) {
            expect(textBlock.text as string).not.toContain(' maya');
          }
        }
      });
    });

    describe('layout template safety (no text/image overlap)', () => {
      function boxesOverlap(
        a: { x: number; y: number; width: number; height: number },
        b: { x: number; y: number; width: number; height: number },
      ): boolean {
        return (
          a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y
        );
      }

      it('no interior page entry has an overlapping imageBlock and textBlock box', async () => {
        // Cover/back-cover entries intentionally overlay title/summary text on
        // top of a full-bleed image (the "full-page cover" template) — that
        // overlap is by design. Interior pages use side-by-side/stacked
        // templates where the image and text regions must never intersect.
        const book = makeBook({ childName: 'Mia', theme: 'friendship', pageCount: 12 });
        setupMocks();

        await service.startBookGeneration(book);

        const updateArg = prisma.book.update.mock.calls[0]?.[0];
        const layout = updateArg?.data?.bookLayout as Record<string, unknown>;
        const entries = layout.entries as Array<
          Record<string, unknown> & {
            kind: string;
            imageBlock?: { box: { x: number; y: number; width: number; height: number } };
            textBlock?: { box: { x: number; y: number; width: number; height: number } };
          }
        >;
        const pageEntries = entries.filter((e) => e.kind === 'page');
        expect(pageEntries.length).toBeGreaterThan(0);
        for (const entry of pageEntries) {
          if (entry.imageBlock && entry.textBlock) {
            expect(boxesOverlap(entry.imageBlock.box, entry.textBlock.box)).toBe(false);
          }
        }
      });

      it('falls back to the text_only template (no imageBlock) when a page has no matching image', async () => {
        const book = makeBook({ childName: 'Mia', theme: 'friendship', pageCount: 4 });
        setupMocks();
        const noImageForPage2Provider: StoryGenerationProvider = {
          async generateStory(input) {
            const result = await new MockStoryGenerationProvider().generateStory(input);
            return {
              ...result,
              imageGenerationResult: {
                ...result.imageGenerationResult,
                images: result.imageGenerationResult.images.filter(
                  (img) => !(img.kind === 'page' && img.pageNumber === 2),
                ),
              },
            };
          },
        };
        const serviceWithGap = new AgentService(
          prisma as never,
          mockPdfStorage as unknown as PdfStorage,
          mockImageAssetStorage as unknown as ImageAssetStorage,
          noImageForPage2Provider,
          new MockImageGenerationProvider(),
        );

        await serviceWithGap.startBookGeneration(book);

        const updateArg = prisma.book.update.mock.calls[0]?.[0];
        const layout = updateArg?.data?.bookLayout as Record<string, unknown>;
        const entries = layout.entries as Array<Record<string, unknown>>;
        const page2Entry = entries.find((e) => e.kind === 'page' && e.pageNumber === 2);
        expect(page2Entry?.template).toBe('text_only');
        expect(page2Entry?.imageBlock).toBeUndefined();
        expect(page2Entry?.textBlock).toBeDefined();
      });
    });
  });
});
