import { vi, describe, it, expect, beforeEach } from 'vitest';
import type { Book } from '@prisma/client';
import { AgentService } from './agent.service';
import { createMockPrisma } from '../common/test-utils/mock-prisma';
import type { PdfStorage } from '../pdf/pdf-storage';
import type { ImageAssetStorage } from '../images/image-asset-storage';

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
      prisma.book.update
        .mockResolvedValueOnce(layoutBook)
        .mockResolvedValueOnce(completedBook);
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

      const entries = (prisma.agentLog.createMany.mock.calls[0]?.[0]?.data as Array<
        Record<string, unknown>
      >);
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

      const entries = (prisma.agentLog.createMany.mock.calls[0]?.[0]?.data as Array<
        Record<string, unknown>
      >);
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
  });
});
