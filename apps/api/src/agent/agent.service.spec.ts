import { vi, describe, it, expect, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';
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
import {
  MockCharacterProfileProvider,
  type CharacterProfileProvider,
} from './character-profile-provider';
import { buildInputSnapshot } from './generation-input-snapshot';
import type { GenerationExecutionContext } from './generation-execution-context';
import type { GenerationExecutionService } from './generation-execution.service';
import type { GenerationOutcome } from './generation-outcome';
import {
  claimImageAssetKey,
  claimCharacterSheetAssetKey,
  imageAssetKey,
  characterSheetAssetKey,
} from '../images/image-asset-storage';
import { InvalidGenerationArtifactPointerError } from './generation-artifact-namespace';

// Phase B, Slice B3: every test defaults to executing as claim (RUN_1, fencingVersion 1) —
// see ctxFor. The "idempotent resume" suite below deliberately claims a *second*,
// distinct run (RUN_2) for a resumed attempt, matching how a real retry/regenerate
// always executes under a new GenerationRun/claim, never the same one — so those
// tests genuinely exercise copy-forward from RUN_1 (source) into RUN_2 (current),
// not same-key idempotent reuse.
const RUN_1 = 'run-1';
const RUN_2 = 'run-2';

function claimNs(runId: string, fencingVersion = 1) {
  return { kind: 'claim' as const, runId, fencingVersion };
}

function imgKey(
  runId: string,
  kind: 'cover' | 'page' | 'back_cover',
  pageNumber?: number,
  fencingVersion = 1,
): string {
  return claimImageAssetKey('b-1', claimNs(runId, fencingVersion), kind, pageNumber);
}

function sheetKey(runId: string, fencingVersion = 1): string {
  return claimCharacterSheetAssetKey('b-1', claimNs(runId, fencingVersion));
}

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
    childPhotoAssetKey: null,
    childPhotoContentType: null,
    childPhotoSha256: null,
    childPhotoSizeBytes: null,
    characterProfile: null,
    characterSheetAssetKey: null,
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
    activeRunId: null,
    publishedRunId: null,
    lastGenerationInputHash: null,
    deletedAt: null,
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
    ...overrides,
  };
}

function ctxFor(
  book: Book,
  inputHash = 'hash-1',
  ctxOverrides: Partial<GenerationExecutionContext> = {},
): GenerationExecutionContext {
  return {
    runId: RUN_1,
    bookId: book.id,
    fencingVersion: 1,
    inputHash,
    inputSnapshot: buildInputSnapshot(book),
    ...ctxOverrides,
  };
}

/**
 * Every test in this file builds a `book: Book` object directly and passes it
 * to AgentService — startBookGeneration now takes a GenerationExecutionContext
 * and reloads the Book row itself (see AgentService's own doc comment), so
 * this seeds that reload with the exact same object the test constructed,
 * keeping every existing test's "inject a book, assert on prisma.book.update"
 * shape unchanged.
 */
function runGeneration(
  targetService: AgentService,
  mockPrisma: MockPrisma,
  book: Book,
  inputHash = 'hash-1',
  ctxOverrides: Partial<GenerationExecutionContext> = {},
): Promise<GenerationOutcome> {
  mockPrisma.book.findUniqueOrThrow.mockResolvedValue(book);
  return targetService.startBookGeneration(ctxFor(book, inputHash, ctxOverrides));
}

describe('AgentService', () => {
  let service: AgentService;
  let prisma: MockPrisma;
  let mockPdfStorage: {
    savePreviewPdf: ReturnType<typeof vi.fn>;
    previewPdfExists: ReturnType<typeof vi.fn>;
    saveClaimPreviewPdf: ReturnType<typeof vi.fn>;
    getClaimPreviewPdf: ReturnType<typeof vi.fn>;
    claimPreviewPdfExists: ReturnType<typeof vi.fn>;
  };
  let mockImageAssetStorage: {
    saveImageAsset: ReturnType<typeof vi.fn>;
    getImageAsset: ReturnType<typeof vi.fn>;
    copyImageAsset: ReturnType<typeof vi.fn>;
  };
  // Backs mockImageAssetStorage so getImageAsset actually reflects what
  // saveImageAsset stored, the same round-trip contract LocalImageAssetStorage
  // and CloudImageAssetStorage provide in production. Without this, every test
  // would see getImageAsset return undefined regardless of what was "saved",
  // which used to make the missing-image validation impossible to test truthfully.
  let savedAssets: Map<string, Buffer>;
  let generationExecutionService: GenerationExecutionService;

  beforeEach(() => {
    vi.clearAllMocks();
    prisma = createMockPrisma();
    mockPdfStorage = {
      savePreviewPdf: vi.fn(),
      previewPdfExists: vi.fn().mockResolvedValue(false),
      saveClaimPreviewPdf: vi.fn(),
      getClaimPreviewPdf: vi.fn(),
      claimPreviewPdfExists: vi.fn().mockResolvedValue(false),
    };
    savedAssets = new Map<string, Buffer>();
    mockImageAssetStorage = {
      saveImageAsset: vi.fn(async (key: string, buffer: Buffer) => {
        savedAssets.set(key, buffer);
        return { key, path: key, contentType: 'image/png' as const };
      }),
      getImageAsset: vi.fn(async (key: string) => savedAssets.get(key)),
      // Mirrors LocalImageAssetStorage/CloudImageAssetStorage.copyImageAsset
      // (Phase B, Slice B2): resolves undefined only for a genuinely missing
      // source, otherwise copies the same bytes to the destination key.
      copyImageAsset: vi.fn(async (sourceKey: string, destinationKey: string) => {
        const buffer = savedAssets.get(sourceKey);
        if (buffer == null) return undefined;
        savedAssets.set(destinationKey, buffer);
        return { key: destinationKey, path: destinationKey, contentType: 'image/png' as const };
      }),
    };
    // Fencing/claim/heartbeat correctness is covered by generation-execution.
    // service.spec.ts and books.service.spec.ts — here it's a thin pass-through
    // to prisma.book.update so this file's book-update assertions are unaffected.
    generationExecutionService = {
      applyFencedBookWrite: vi.fn((ctx: GenerationExecutionContext, data: unknown) =>
        prisma.book.update({ where: { id: ctx.bookId }, data }),
      ),
    } as unknown as GenerationExecutionService;
    service = new AgentService(
      prisma as never,
      mockPdfStorage as unknown as PdfStorage,
      mockImageAssetStorage as unknown as ImageAssetStorage,
      new MockStoryGenerationProvider(),
      new MockImageGenerationProvider(),
      new MockCharacterProfileProvider(),
      generationExecutionService as never,
    );
    vi.mocked(renderStorybookPdf).mockResolvedValue(Buffer.from('%PDF-1.4 mock'));
    mockPdfStorage.savePreviewPdf.mockResolvedValue({
      url: '/files/books/b-1/storybook.pdf',
      path: '/api/tmp/books/b-1/storybook.pdf',
    });
    // Phase B, Slice B4: AgentService now writes PDFs under the current
    // claim's namespace, never the legacy key — see saveClaimPreviewPdf below.
    mockPdfStorage.saveClaimPreviewPdf.mockResolvedValue({
      url: '/files/books/b-1/runs/run-1/claims/1/storyme-preview-b-1.pdf',
      path: '/api/tmp/books/b-1/runs/run-1/claims/1/storyme-preview-b-1.pdf',
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

      await runGeneration(service, prisma, book);

      expect(prisma.book.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'b-1' },
          data: expect.objectContaining({ status: 'layout' }),
        }),
      );
    });

    it('returns a completed GenerationOutcome without writing status itself', async () => {
      const book = makeBook();
      setupMocks();

      const result = await runGeneration(service, prisma, book);

      expect(result.status).toBe('complete');
      expect(result.bookUpdate).not.toHaveProperty('status');
    });

    it('stamps Book.lastGenerationInputHash with the inputHash this run executed, at the phase-1 persist', async () => {
      const book = makeBook();
      setupMocks();

      await runGeneration(service, prisma, book, 'the-run-inputhash');

      expect(prisma.book.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ lastGenerationInputHash: 'the-run-inputhash' }),
        }),
      );
    });

    it('stores a characterCard derived from the book fields', async () => {
      const book = makeBook({ childName: 'Mia', childAge: 5 });
      setupMocks();

      await runGeneration(service, prisma, book);

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

      await runGeneration(service, prisma, book);

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

      await runGeneration(service, prisma, book);

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

      await runGeneration(service, prisma, book);

      const updateArg = prisma.book.update.mock.calls[0]?.[0];
      const plan = updateArg?.data?.storyPlan as Record<string, unknown>;
      const pages = plan?.pages as Array<Record<string, unknown>>;
      expect(pages.length).toBe(4);
    });

    it('defaults to 6 pages when the book has no persisted pageCount', async () => {
      const book = makeBook({ childName: 'Mia', theme: 'friendship', pageCount: null });
      setupMocks();

      await runGeneration(service, prisma, book);

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

      await runGeneration(service, prisma, book);

      const updateArg = prisma.book.update.mock.calls[0]?.[0];
      const plan = updateArg?.data?.storyPlan as Record<string, unknown>;
      expect(plan?.educationalMessage).toBe('It is okay to make mistakes');
    });

    it('assigns globally incrementing pageNumbers starting from 1', async () => {
      const book = makeBook();
      setupMocks();

      await runGeneration(service, prisma, book);

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

      await runGeneration(service, prisma, book);

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

      await runGeneration(service, prisma, book);

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

      await runGeneration(service, prisma, book);

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

      await runGeneration(service, prisma, book);

      const updateArg = prisma.book.update.mock.calls[0]?.[0];
      expect(typeof updateArg?.data?.title).toBe('string');
      expect(updateArg?.data?.title).toContain('Mia');
    });

    it('returns nine AgentLog records on the outcome, all sharing the same traceId', async () => {
      const book = makeBook();
      setupMocks();

      const result = await runGeneration(service, prisma, book);

      const entries = result.agentLogs as unknown as Array<Record<string, unknown>>;
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

      await runGeneration(service, prisma, book);

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

      await runGeneration(service, prisma, book);

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

      await runGeneration(service, prisma, book);

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

      await runGeneration(service, prisma, book);

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

      await runGeneration(service, prisma, book);

      const updateArg = prisma.book.update.mock.calls[0]?.[0];
      const card = updateArg?.data?.characterCard as Record<string, unknown>;
      const plan = updateArg?.data?.storyPlan as Record<string, unknown>;
      expect(card?.name).toBe('Leo');
      expect(plan?.theme).toBe('courage');
    });

    it('stores bookPreview with a non-empty title', async () => {
      const book = makeBook({ childName: 'Mia', theme: 'friendship' });
      setupMocks();

      await runGeneration(service, prisma, book);

      const updateArg = prisma.book.update.mock.calls[0]?.[0];
      const preview = updateArg?.data?.bookPreview as Record<string, unknown>;
      expect(preview).toBeDefined();
      expect(typeof preview?.title).toBe('string');
      expect((preview?.title as string).length).toBeGreaterThan(0);
    });

    it('stores bookPreview with a cover', async () => {
      const book = makeBook({ childName: 'Mia', theme: 'friendship' });
      setupMocks();

      await runGeneration(service, prisma, book);

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

      await runGeneration(service, prisma, book);

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

      await runGeneration(service, prisma, book);

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

      await runGeneration(service, prisma, book);

      const updateArg = prisma.book.update.mock.calls[0]?.[0];
      const preview = updateArg?.data?.bookPreview as Record<string, unknown>;
      const pages = preview?.pages as unknown[];
      const metadata = preview?.metadata as Record<string, unknown>;
      expect(metadata?.totalPages).toBe(pages.length);
    });

    it('storyText remains present on every page after buildBookPreview', async () => {
      const book = makeBook({ childName: 'Mia', theme: 'friendship' });
      setupMocks();

      await runGeneration(service, prisma, book);

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

      await runGeneration(service, prisma, book);

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

      await runGeneration(service, prisma, book);

      const updateArg = prisma.book.update.mock.calls[0]?.[0];
      const result = updateArg?.data?.imageGenerationResult as Record<string, unknown>;
      expect(result).toBeDefined();
      expect(result).not.toBeNull();
    });

    it('imageGenerationResult provider is local_mock', async () => {
      const book = makeBook();
      setupMocks();

      await runGeneration(service, prisma, book);

      const updateArg = prisma.book.update.mock.calls[0]?.[0];
      const result = updateArg?.data?.imageGenerationResult as Record<string, unknown>;
      expect(result.provider).toBe('local_mock');
      expect(result.status).toBe('complete');
    });

    it('imageGenerationResult.imageByteProvider reflects the injected ImageGenerationProvider, not the plan provider', async () => {
      const book = makeBook();
      setupMocks();

      await runGeneration(service, prisma, book);

      const updateArg = prisma.book.update.mock.calls[0]?.[0];
      const result = updateArg?.data?.imageGenerationResult as Record<string, unknown>;
      expect(result.imageByteProvider).toBe('mock');
    });

    it('persists safe per-call provider usage without raw prompts', async () => {
      const book = makeBook();
      setupMocks();

      await runGeneration(service, prisma, book);

      const updateArg = prisma.book.update.mock.calls[0]?.[0];
      const result = updateArg?.data?.imageGenerationResult as Record<string, unknown>;
      const usage = result.providerUsage as {
        plannedPaidCalls: number;
        actualPaidCalls: number;
        estimatedCostUsd: number;
        calls: Array<Record<string, unknown>>;
      };
      expect(usage).toMatchObject({
        plannedPaidCalls: 0,
        actualPaidCalls: 0,
        estimatedCostUsd: 0,
      });
      expect(usage.calls).toHaveLength(11);
      expect(usage.calls.map((call) => call.operation)).toEqual([
        'character_profile',
        'character_sheet',
        'story',
        ...Array(8).fill('illustration'),
      ]);
      expect(usage.calls.every((call) => /^[a-f0-9]{64}$/.test(String(call.promptHash)))).toBe(
        true,
      );
      expect(JSON.stringify(usage)).not.toContain('preserve the exact same appearance');
    });

    it('imageGenerationResult includes a cover image', async () => {
      const book = makeBook({ childName: 'Mia', theme: 'friendship' });
      setupMocks();

      await runGeneration(service, prisma, book);

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

      await runGeneration(service, prisma, book);

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

      await runGeneration(service, prisma, book);

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

      await runGeneration(service, prisma, book);

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

      await runGeneration(service, prisma, book);

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

      await runGeneration(service, prisma, book);

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

      await runGeneration(service, prisma, book);

      prisma.book.update.mockClear();
      prisma.agentLog.createMany.mockClear();
      setupMocks();

      await runGeneration(service, prisma, book);

      const firstArg = prisma.book.update.mock.calls[0]?.[0];
      const firstResult = firstArg?.data?.imageGenerationResult as Record<string, unknown>;
      expect(firstResult.provider).toBe('local_mock');
      expect(firstResult.status).toBe('complete');
    });

    it('bookPreview is still stored alongside imageGenerationResult', async () => {
      const book = makeBook({ childName: 'Mia', theme: 'friendship' });
      setupMocks();

      await runGeneration(service, prisma, book);

      const updateArg = prisma.book.update.mock.calls[0]?.[0];
      const preview = updateArg?.data?.bookPreview as Record<string, unknown>;
      expect(preview).toBeDefined();
      expect(typeof preview?.title).toBe('string');
    });

    // ── Phase 2W: Mock local image producer wiring ────────────────────────────

    it('saves a mock image asset for every generated image entry', async () => {
      const book = makeBook({ childName: 'Mia', theme: 'friendship' });
      setupMocks();

      await runGeneration(service, prisma, book);

      const updateArg = prisma.book.update.mock.calls[0]?.[0];
      const result = updateArg?.data?.imageGenerationResult as Record<string, unknown>;
      const images = result.images as Array<Record<string, unknown>>;
      // +1 for the char_build character-sheet save.
      expect(mockImageAssetStorage.saveImageAsset).toHaveBeenCalledTimes(images.length + 1);
    });

    it('saves each mock image asset with a non-empty PNG buffer under the matching key', async () => {
      const book = makeBook();
      setupMocks();

      await runGeneration(service, prisma, book);

      const coverCall = mockImageAssetStorage.saveImageAsset.mock.calls.find(
        (call) => call[0] === imgKey(RUN_1, 'cover'),
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

      await runGeneration(service, prisma, book);

      const saveOrder = mockImageAssetStorage.saveImageAsset.mock.invocationCallOrder[0]!;
      const renderOrder = vi.mocked(renderStorybookPdf).mock.invocationCallOrder[0]!;
      expect(saveOrder).toBeLessThan(renderOrder);
    });

    it('marks the book failed at the pdf_render step when a mock image save fails (that page would otherwise render without its illustration)', async () => {
      const book = makeBook();
      setupMocks();
      // The character-sheet save (char_build) is always the first
      // saveImageAsset call — let it succeed, then fail the next (first
      // per-image) call.
      mockImageAssetStorage.saveImageAsset
        .mockResolvedValueOnce({
          key: sheetKey(RUN_1),
          path: sheetKey(RUN_1),
          contentType: 'image/png' as const,
        })
        .mockRejectedValueOnce(new Error('disk full'));

      const result = await runGeneration(service, prisma, book);

      expect(result.status).toBe('failed');
      expect(result.failedStep).toBe('pdf_render');
      expect(renderStorybookPdf).not.toHaveBeenCalled();
    });

    it('logs a warning and continues saving other images when one mock image save fails', async () => {
      const book = makeBook();
      setupMocks();
      const warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      // The character-sheet save (char_build) is always the first
      // saveImageAsset call — let it succeed, then fail the next (first
      // per-image) call.
      mockImageAssetStorage.saveImageAsset
        .mockResolvedValueOnce({
          key: sheetKey(RUN_1),
          path: sheetKey(RUN_1),
          contentType: 'image/png' as const,
        })
        .mockRejectedValueOnce(new Error('disk full'));

      await runGeneration(service, prisma, book);

      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Image generation/save failed'));
      const updateArg = prisma.book.update.mock.calls[0]?.[0];
      const result = updateArg?.data?.imageGenerationResult as Record<string, unknown>;
      const images = result.images as Array<Record<string, unknown>>;
      // +1 for the char_build character-sheet save.
      expect(mockImageAssetStorage.saveImageAsset).toHaveBeenCalledTimes(images.length + 1);
      warnSpy.mockRestore();
    });

    // ── Phase 3C: ImageGenerationProvider boundary — per-image failures are
    // tolerated and logged individually during generation, but any entry left
    // without saved bytes now fails the book at the pdf_render step (see
    // assertAllImagesResolved in agent.service.ts) instead of silently
    // rendering a placeholder for it.

    describe('when the image generation provider fails for some or all images', () => {
      function makePartiallyFailingImageService(shouldFail: (entryId: string) => boolean) {
        const failingImageProvider: ImageGenerationProvider = {
          generateImage: vi.fn().mockImplementation(async ({ entry }) => {
            if (shouldFail(entry.id)) {
              throw new Error(`OpenAI image request failed for ${entry.id}`);
            }
            return { buffer: Buffer.from('fake-png'), contentType: 'image/png' as const };
          }),
          generateCharacterSheet: vi.fn().mockResolvedValue({
            buffer: Buffer.from('fake-png'),
            contentType: 'image/png' as const,
          }),
        };
        return new AgentService(
          prisma as never,
          mockPdfStorage as unknown as PdfStorage,
          mockImageAssetStorage as unknown as ImageAssetStorage,
          new MockStoryGenerationProvider(),
          failingImageProvider,
          new MockCharacterProfileProvider(),
          generationExecutionService as never,
        );
      }

      it('marks the book failed at pdf_render (without ever calling the renderer) when every image fails', async () => {
        const book = makeBook();
        setupMocks();
        const warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
        const failingService = makePartiallyFailingImageService(() => true);

        const result = await runGeneration(failingService, prisma, book);

        expect(result.status).toBe('failed');
        expect(result.failedStep).toBe('pdf_render');
        expect(renderStorybookPdf).not.toHaveBeenCalled();
        expect(mockPdfStorage.savePreviewPdf).not.toHaveBeenCalled();
        // Only the char_build character-sheet save happens — per-page/cover
        // illustration generation is what's failing here.
        expect(mockImageAssetStorage.saveImageAsset).toHaveBeenCalledTimes(1);
        expect(mockImageAssetStorage.saveImageAsset).toHaveBeenCalledWith(
          sheetKey(RUN_1),
          expect.any(Buffer),
          'image/png',
        );
        warnSpy.mockRestore();
      });

      it('saves bytes only for entries that succeeded, then fails the book at pdf_render because the cover illustration is missing', async () => {
        const book = makeBook();
        setupMocks();
        const failingService = makePartiallyFailingImageService((id) => id === 'b-1-cover');

        const result = await runGeneration(failingService, prisma, book);

        expect(mockImageAssetStorage.saveImageAsset).not.toHaveBeenCalledWith(
          imgKey(RUN_1, 'cover'),
          expect.anything(),
          expect.anything(),
        );
        const pageOneCall = mockImageAssetStorage.saveImageAsset.mock.calls.find(
          (call) => call[0] === imgKey(RUN_1, 'page', 1),
        );
        expect(pageOneCall).toBeDefined();

        expect(result.status).toBe('failed');
        expect(result.failedStep).toBe('pdf_render');
        expect(result.errorMessage).toContain('cover');
      });

      it('records generatedImageCount/failedImageCount/lastImageError on imageGenerationResult', async () => {
        const book = makeBook();
        setupMocks();
        const failingService = makePartiallyFailingImageService((id) => id === 'b-1-cover');

        await runGeneration(failingService, prisma, book);

        const updateArg = prisma.book.update.mock.calls[0]?.[0];
        const result = updateArg?.data?.imageGenerationResult as Record<string, unknown>;
        const images = result.images as Array<Record<string, unknown>>;
        expect(result.failedImageCount).toBe(1);
        expect(result.generatedImageCount).toBe(images.length - 1);
        expect(result.lastImageError).toContain('b-1-cover');
      });

      it('the image_gen AgentLog row is truthfully marked error (not success) with a safe summary error when every attempted image fails', async () => {
        const book = makeBook();
        setupMocks();
        const failingService = makePartiallyFailingImageService(() => true);

        const result = await runGeneration(failingService, prisma, book);

        const entries = result.agentLogs as unknown as Array<Record<string, unknown>>;
        const imageGenEntry = entries.find((e) => e.step === 'image_gen');
        expect(imageGenEntry?.status).toBe('error');
        expect(imageGenEntry?.error).toEqual(expect.stringContaining('failed to generate'));

        const pdfEntry = entries.find((e) => e.step === 'pdf_render');
        expect(pdfEntry?.status).toBe('error');
      });
    });

    // ── Character profile / character sheet fallback tolerance ────────────────

    describe('when the character profile provider or character sheet generation fails', () => {
      function makeFailingProfileProvider(): CharacterProfileProvider {
        return {
          providerName: 'openai',
          buildProfile: vi.fn().mockRejectedValue(new Error('vision request failed')),
        };
      }

      function makeSheetFailingImageProvider(): ImageGenerationProvider {
        return {
          generateImage: vi.fn().mockResolvedValue({
            buffer: Buffer.from('fake-png'),
            contentType: 'image/png' as const,
          }),
          generateCharacterSheet: vi
            .fn()
            .mockRejectedValue(new Error('character sheet request failed')),
        };
      }

      it('falls back to a generic character profile and continues the rest of the pipeline when the character profile provider throws', async () => {
        const book = makeBook();
        setupMocks();
        const warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
        const service = new AgentService(
          prisma as never,
          mockPdfStorage as unknown as PdfStorage,
          mockImageAssetStorage as unknown as ImageAssetStorage,
          new MockStoryGenerationProvider(),
          new MockImageGenerationProvider(),
          makeFailingProfileProvider(),
          generationExecutionService as never,
        );

        const result = await runGeneration(service, prisma, book);

        // The pipeline is not aborted by a profile-provider failure — it still
        // reaches PDF rendering using a locally-built fallback profile.
        expect(renderStorybookPdf).toHaveBeenCalled();

        const phase1UpdateArg = prisma.book.update.mock.calls[0]?.[0];
        const persistedProfile = phase1UpdateArg?.data?.characterProfile as Record<string, unknown>;
        expect(persistedProfile.childName).toBe('Mia');
        expect(persistedProfile.consistencyPrompt).toBeTruthy();

        const entries = result.agentLogs as unknown as Array<Record<string, unknown>>;
        const charBuildEntry = entries.find((e) => e.step === 'char_build');
        expect(charBuildEntry?.status).toBe('error');
        expect(charBuildEntry?.provider).toBe('mock');
        expect(charBuildEntry?.error).toContain('vision request failed');
        warnSpy.mockRestore();
      });

      it('continues without a character-sheet reference image when character-sheet generation fails, leaving hasCharacterSheet false', async () => {
        const book = makeBook();
        setupMocks();
        const warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
        const service = new AgentService(
          prisma as never,
          mockPdfStorage as unknown as PdfStorage,
          mockImageAssetStorage as unknown as ImageAssetStorage,
          new MockStoryGenerationProvider(),
          makeSheetFailingImageProvider(),
          new MockCharacterProfileProvider(),
          generationExecutionService as never,
        );

        const result = await runGeneration(service, prisma, book);

        expect(mockImageAssetStorage.saveImageAsset).not.toHaveBeenCalledWith(
          sheetKey(RUN_1),
          expect.anything(),
          expect.anything(),
        );
        // Every page/cover illustration still generates normally — only the
        // standalone character-sheet reference image is missing.
        expect(renderStorybookPdf).toHaveBeenCalled();

        const phase1UpdateArg = prisma.book.update.mock.calls[0]?.[0];
        const persistedProfile = phase1UpdateArg?.data?.characterProfile as Record<string, unknown>;
        expect(persistedProfile.hasCharacterSheet).toBe(false);
        expect(phase1UpdateArg?.data?.characterSheetAssetKey).toBeUndefined();

        // The profile step itself succeeded — only the sheet (a best-effort
        // consistency aid) failed, so char_build is not marked errored.
        const entries = result.agentLogs as unknown as Array<Record<string, unknown>>;
        const charBuildEntry = entries.find((e) => e.step === 'char_build');
        expect(charBuildEntry?.status).toBe('success');
        warnSpy.mockRestore();
      });
    });

    // ── Child photo integrity (sha256/size verification before use) ──────────

    describe('child photo integrity verification', () => {
      const CHILD_PHOTO_BYTES = Buffer.from('fake-child-photo-bytes');
      const CHILD_PHOTO_SHA256 = createHash('sha256').update(CHILD_PHOTO_BYTES).digest('hex');

      function makeBookWithChildPhoto(overrides: Partial<Book> = {}): Book {
        return makeBook({
          childPhotoAssetKey: 'b-1/child-photo-v1',
          childPhotoContentType: 'image/jpeg' as Book['childPhotoContentType'],
          childPhotoSha256: CHILD_PHOTO_SHA256,
          childPhotoSizeBytes: CHILD_PHOTO_BYTES.length,
          ...overrides,
        });
      }

      it('uses the photo when its bytes match the recorded sha256/size exactly', async () => {
        const book = makeBookWithChildPhoto();
        setupMocks();
        mockImageAssetStorage.getImageAsset.mockImplementation(async (key: string) =>
          key === 'b-1/child-photo-v1' ? CHILD_PHOTO_BYTES : savedAssets.get(key),
        );
        const profileProvider = {
          providerName: 'mock',
          buildProfile: vi
            .fn()
            .mockImplementation((input) => new MockCharacterProfileProvider().buildProfile(input)),
        };
        const service = new AgentService(
          prisma as never,
          mockPdfStorage as unknown as PdfStorage,
          mockImageAssetStorage as unknown as ImageAssetStorage,
          new MockStoryGenerationProvider(),
          new MockImageGenerationProvider(),
          profileProvider,
          generationExecutionService as never,
        );

        await runGeneration(service, prisma, book);

        expect(profileProvider.buildProfile).toHaveBeenCalledWith(
          expect.objectContaining({
            photo: { base64: CHILD_PHOTO_BYTES.toString('base64'), contentType: 'image/jpeg' },
          }),
        );
      });

      it('degrades to text-only (never uses the bytes) and logs a stable CHILD_PHOTO_INTEGRITY_MISMATCH error when the loaded bytes are truncated', async () => {
        const book = makeBookWithChildPhoto();
        setupMocks();
        const truncated = CHILD_PHOTO_BYTES.subarray(0, CHILD_PHOTO_BYTES.length - 5);
        mockImageAssetStorage.getImageAsset.mockImplementation(async (key: string) =>
          key === 'b-1/child-photo-v1' ? truncated : savedAssets.get(key),
        );
        const errorSpy = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
        const profileProvider = {
          providerName: 'mock',
          buildProfile: vi
            .fn()
            .mockImplementation((input) => new MockCharacterProfileProvider().buildProfile(input)),
        };
        const service = new AgentService(
          prisma as never,
          mockPdfStorage as unknown as PdfStorage,
          mockImageAssetStorage as unknown as ImageAssetStorage,
          new MockStoryGenerationProvider(),
          new MockImageGenerationProvider(),
          profileProvider,
          generationExecutionService as never,
        );

        const result = await runGeneration(service, prisma, book);

        expect(profileProvider.buildProfile).toHaveBeenCalledWith(
          expect.objectContaining({ photo: undefined }),
        );
        expect(errorSpy).toHaveBeenCalledWith(
          expect.stringContaining('CHILD_PHOTO_INTEGRITY_MISMATCH'),
        );
        const entries = result.agentLogs as unknown as Array<Record<string, unknown>>;
        const charBuildEntry = entries.find((e) => e.step === 'char_build');
        expect(charBuildEntry?.error).toContain('CHILD_PHOTO_INTEGRITY_MISMATCH');
        errorSpy.mockRestore();
      });

      it('degrades to text-only and logs CHILD_PHOTO_INTEGRITY_MISMATCH when the bytes are the right size but a digest mismatch (replaced/corrupted content)', async () => {
        const book = makeBookWithChildPhoto();
        setupMocks();
        // Same length as CHILD_PHOTO_BYTES, different content entirely.
        const swapped = Buffer.alloc(CHILD_PHOTO_BYTES.length, 'x');
        mockImageAssetStorage.getImageAsset.mockImplementation(async (key: string) =>
          key === 'b-1/child-photo-v1' ? swapped : savedAssets.get(key),
        );
        const errorSpy = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
        const profileProvider = {
          providerName: 'mock',
          buildProfile: vi
            .fn()
            .mockImplementation((input) => new MockCharacterProfileProvider().buildProfile(input)),
        };
        const service = new AgentService(
          prisma as never,
          mockPdfStorage as unknown as PdfStorage,
          mockImageAssetStorage as unknown as ImageAssetStorage,
          new MockStoryGenerationProvider(),
          new MockImageGenerationProvider(),
          profileProvider,
          generationExecutionService as never,
        );

        await runGeneration(service, prisma, book);

        expect(profileProvider.buildProfile).toHaveBeenCalledWith(
          expect.objectContaining({ photo: undefined }),
        );
        expect(errorSpy).toHaveBeenCalledWith(
          expect.stringContaining('CHILD_PHOTO_INTEGRITY_MISMATCH'),
        );
        errorSpy.mockRestore();
      });

      it('degrades to text-only with only a warning (not the integrity error) when the asset is simply missing from storage', async () => {
        const book = makeBookWithChildPhoto();
        setupMocks();
        mockImageAssetStorage.getImageAsset.mockImplementation(async (key: string) =>
          key === 'b-1/child-photo-v1' ? undefined : savedAssets.get(key),
        );
        const warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
        const errorSpy = vi.spyOn(Logger.prototype, 'error');
        const profileProvider = {
          providerName: 'mock',
          buildProfile: vi
            .fn()
            .mockImplementation((input) => new MockCharacterProfileProvider().buildProfile(input)),
        };
        const service = new AgentService(
          prisma as never,
          mockPdfStorage as unknown as PdfStorage,
          mockImageAssetStorage as unknown as ImageAssetStorage,
          new MockStoryGenerationProvider(),
          new MockImageGenerationProvider(),
          profileProvider,
          generationExecutionService as never,
        );

        await runGeneration(service, prisma, book);

        expect(profileProvider.buildProfile).toHaveBeenCalledWith(
          expect.objectContaining({ photo: undefined }),
        );
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('no bytes were found'));
        expect(errorSpy).not.toHaveBeenCalledWith(
          expect.stringContaining('CHILD_PHOTO_INTEGRITY_MISMATCH'),
        );
        warnSpy.mockRestore();
      });
    });

    // ── Character-sheet visual reference (character-reference-edit path) ─────

    describe('character-sheet reference image passed to page/cover generation', () => {
      function makeReferenceAwareImageProvider(): ImageGenerationProvider & {
        generateImage: ReturnType<typeof vi.fn>;
        generateCharacterSheet: ReturnType<typeof vi.fn>;
      } {
        return {
          providerName: 'openai' as const,
          modelName: 'gpt-image-1',
          generateImage: vi
            .fn()
            .mockImplementation(async (input: { characterReference?: unknown }) => ({
              buffer: Buffer.from('fake-png'),
              contentType: 'image/png' as const,
              usedReference: !!input.characterReference,
            })),
          generateCharacterSheet: vi.fn().mockResolvedValue({
            buffer: Buffer.from('fake-character-sheet-png'),
            contentType: 'image/png' as const,
          }),
        };
      }

      it('loads the character-sheet bytes only once, then passes the same reference to every generateImage call', async () => {
        const book = makeBook();
        setupMocks();
        const provider = makeReferenceAwareImageProvider();
        const referenceService = new AgentService(
          prisma as never,
          mockPdfStorage as unknown as PdfStorage,
          mockImageAssetStorage as unknown as ImageAssetStorage,
          new MockStoryGenerationProvider(),
          provider,
          new MockCharacterProfileProvider(),
          generationExecutionService as never,
        );

        await runGeneration(referenceService, prisma, book);

        const sheetReads = mockImageAssetStorage.getImageAsset.mock.calls.filter(
          (call) => call[0] === sheetKey(RUN_1),
        );
        expect(sheetReads).toHaveLength(1);

        expect(provider.generateImage).toHaveBeenCalled();
        for (const call of provider.generateImage.mock.calls) {
          const input = call[0] as { characterReference?: { buffer: Buffer } };
          expect(input.characterReference).toBeDefined();
          expect(Buffer.isBuffer(input.characterReference!.buffer)).toBe(true);
        }
      });

      it('records characterReferenceAvailable/characterReferenceUsedForImages/imageGenerationMode when the reference is actually used', async () => {
        const book = makeBook();
        setupMocks();
        const provider = makeReferenceAwareImageProvider();
        const referenceService = new AgentService(
          prisma as never,
          mockPdfStorage as unknown as PdfStorage,
          mockImageAssetStorage as unknown as ImageAssetStorage,
          new MockStoryGenerationProvider(),
          provider,
          new MockCharacterProfileProvider(),
          generationExecutionService as never,
        );

        await runGeneration(referenceService, prisma, book);

        const updateArg = prisma.book.update.mock.calls[0]?.[0];
        const result = updateArg?.data?.imageGenerationResult as Record<string, unknown>;
        expect(result.characterReferenceAvailable).toBe(true);
        expect(result.characterReferenceUsedForImages).toBe(true);
        expect(result.imageGenerationMode).toBe('character-reference-edit');
      });

      it('falls back to text-only generation but produces an explicit characterReferenceLoadError (not a silent warning) when the character-sheet bytes cannot be read back', async () => {
        const book = makeBook();
        setupMocks();
        const errorSpy = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
        const provider = makeReferenceAwareImageProvider();
        mockImageAssetStorage.getImageAsset.mockImplementation(async (key: string) =>
          key === sheetKey(RUN_1) ? undefined : savedAssets.get(key),
        );
        const referenceService = new AgentService(
          prisma as never,
          mockPdfStorage as unknown as PdfStorage,
          mockImageAssetStorage as unknown as ImageAssetStorage,
          new MockStoryGenerationProvider(),
          provider,
          new MockCharacterProfileProvider(),
          generationExecutionService as never,
        );

        await runGeneration(referenceService, prisma, book);

        expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('bytes could not be loaded'));
        for (const call of provider.generateImage.mock.calls) {
          const input = call[0] as { characterReference?: unknown };
          expect(input.characterReference).toBeUndefined();
        }
        const updateArg = prisma.book.update.mock.calls[0]?.[0];
        const result = updateArg?.data?.imageGenerationResult as Record<string, unknown>;
        expect(result.characterReferenceAvailable).toBe(false);
        expect(result.characterReferenceUsedForImages).toBe(false);
        expect(result.imageGenerationMode).toBe('text-to-image');
        expect(result.characterReferenceLoadError).toEqual(
          expect.stringContaining('recorded as existing but its bytes could not be loaded'),
        );
        errorSpy.mockRestore();
      });

      it('preserves existing text-only behavior when no character-sheet key exists (sheet generation failed)', async () => {
        const book = makeBook();
        setupMocks();
        const warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
        const provider = makeReferenceAwareImageProvider();
        provider.generateCharacterSheet.mockRejectedValue(new Error('sheet generation failed'));
        const referenceService = new AgentService(
          prisma as never,
          mockPdfStorage as unknown as PdfStorage,
          mockImageAssetStorage as unknown as ImageAssetStorage,
          new MockStoryGenerationProvider(),
          provider,
          new MockCharacterProfileProvider(),
          generationExecutionService as never,
        );

        await runGeneration(referenceService, prisma, book);

        for (const call of provider.generateImage.mock.calls) {
          const input = call[0] as { characterReference?: unknown };
          expect(input.characterReference).toBeUndefined();
        }
        const updateArg = prisma.book.update.mock.calls[0]?.[0];
        const result = updateArg?.data?.imageGenerationResult as Record<string, unknown>;
        expect(result.characterReferenceAvailable).toBe(false);
        expect(result.characterReferenceUsedForImages).toBe(false);
        expect(result.imageGenerationMode).toBe('text-to-image');
        warnSpy.mockRestore();
      });

      it('remains compatible with the mock image provider: character sheet may be available but is never reported as used', async () => {
        const book = makeBook();
        setupMocks();

        await runGeneration(service, prisma, book);

        const updateArg = prisma.book.update.mock.calls[0]?.[0];
        const result = updateArg?.data?.imageGenerationResult as Record<string, unknown>;
        expect(result.characterReferenceUsedForImages).toBe(false);
        expect(result.imageGenerationMode).toBe('text-to-image');
      });
    });

    // ── MAX_GENERATED_IMAGES_PER_BOOK atomic book budget ──────────────────────

    describe('MAX_GENERATED_IMAGES_PER_BOOK complete-book budget (real provider only)', () => {
      function makeRealImageProvider() {
        return {
          providerName: 'openai' as const,
          modelName: 'gpt-image-1',
          generateImage: vi.fn().mockResolvedValue({
            buffer: Buffer.from('fake-png'),
            contentType: 'image/png' as const,
          }),
          generateCharacterSheet: vi.fn().mockResolvedValue({
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

      it('rejects an insufficient budget before making any paid page-image request', async () => {
        await withMaxGeneratedImagesEnv('2', async () => {
          const book = makeBook();
          const realProvider = makeRealImageProvider();
          const realService = new AgentService(
            prisma as never,
            mockPdfStorage as unknown as PdfStorage,
            mockImageAssetStorage as unknown as ImageAssetStorage,
            new MockStoryGenerationProvider(),
            realProvider,
            new MockCharacterProfileProvider(),
            generationExecutionService as never,
          );
          setupMocks();

          await expect(runGeneration(realService, prisma, book)).rejects.toThrow(
            /Complete book generation requires 8 illustrations/,
          );

          expect(realProvider.generateImage).not.toHaveBeenCalled();
          // Character profile/sheet precedes image planning in this direct
          // defense-in-depth path. Normal API scheduling rejects even earlier,
          // before the run and credit transaction.
          expect(realProvider.generateCharacterSheet).toHaveBeenCalledOnce();
          expect(renderStorybookPdf).not.toHaveBeenCalled();
        });
      });

      it('does not cap the free mock provider', async () => {
        await withMaxGeneratedImagesEnv('2', async () => {
          const book = makeBook();
          setupMocks();

          await runGeneration(service, prisma, book);

          const updateArg = prisma.book.update.mock.calls[0]?.[0];
          const result = updateArg?.data?.imageGenerationResult as Record<string, unknown>;
          const images = result.images as Array<Record<string, unknown>>;
          expect(images.length).toBeGreaterThan(2);
          // +1 for the char_build character-sheet save.
          expect(mockImageAssetStorage.saveImageAsset).toHaveBeenCalledTimes(images.length + 1);
        });
      });

      it('defaults to enough budget for every illustration in a normal book', async () => {
        await withMaxGeneratedImagesEnv(undefined, async () => {
          const book = makeBook();
          const realProvider = makeRealImageProvider();
          const realService = new AgentService(
            prisma as never,
            mockPdfStorage as unknown as PdfStorage,
            mockImageAssetStorage as unknown as ImageAssetStorage,
            new MockStoryGenerationProvider(),
            realProvider,
            new MockCharacterProfileProvider(),
            generationExecutionService as never,
          );
          setupMocks();

          const result = await runGeneration(realService, prisma, book);

          expect(realProvider.generateImage).toHaveBeenCalledTimes(8);
          expect(result.status).toBe('complete');
        });
      });
    });

    // ── Phase 2H: Layout engine ───────────────────────────────────────────────

    it('stores bookLayout in the book update', async () => {
      const book = makeBook();
      setupMocks();

      await runGeneration(service, prisma, book);

      const updateArg = prisma.book.update.mock.calls[0]?.[0];
      const layout = updateArg?.data?.bookLayout as Record<string, unknown>;
      expect(layout).toBeDefined();
      expect(layout).not.toBeNull();
    });

    it('bookLayout.status is complete', async () => {
      const book = makeBook();
      setupMocks();

      await runGeneration(service, prisma, book);

      const updateArg = prisma.book.update.mock.calls[0]?.[0];
      const layout = updateArg?.data?.bookLayout as Record<string, unknown>;
      expect(layout.status).toBe('complete');
    });

    it('bookLayout.trimSize is square_8x8', async () => {
      const book = makeBook();
      setupMocks();

      await runGeneration(service, prisma, book);

      const updateArg = prisma.book.update.mock.calls[0]?.[0];
      const layout = updateArg?.data?.bookLayout as Record<string, unknown>;
      expect(layout.trimSize).toBe('square_8x8');
    });

    it('bookLayout.entries contains a cover entry', async () => {
      const book = makeBook({ childName: 'Mia', theme: 'friendship' });
      setupMocks();

      await runGeneration(service, prisma, book);

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

      await runGeneration(service, prisma, book);

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

      await runGeneration(service, prisma, book);

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

      await runGeneration(service, prisma, book);

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

      await runGeneration(service, prisma, book);

      const updateArg = prisma.book.update.mock.calls[0]?.[0];
      const layout = updateArg?.data?.bookLayout as Record<string, unknown>;
      const entries = layout.entries as Array<Record<string, unknown>>;
      for (const entry of entries) {
        expect(entry.trimSize).toBe('square_8x8');
      }
    });

    it('every page entry uses the single stable image_top_text_bottom template (no narrow side-by-side columns)', async () => {
      const book = makeBook({ childName: 'Mia', theme: 'friendship' });
      setupMocks();

      await runGeneration(service, prisma, book);

      const updateArg = prisma.book.update.mock.calls[0]?.[0];
      const layout = updateArg?.data?.bookLayout as Record<string, unknown>;
      const entries = layout.entries as Array<Record<string, unknown>>;
      const pageEntries = entries.filter((e) => e.kind === 'page');
      expect(pageEntries.length).toBeGreaterThan(0);
      for (const entry of pageEntries) {
        expect(entry.template).toBe('image_top_text_bottom');
        const imageBlock = entry.imageBlock as Record<string, unknown>;
        const textBlock = entry.textBlock as Record<string, unknown>;
        // Full safe-area width on both blocks — no narrow accidental column.
        expect((imageBlock.box as Record<string, unknown>).width).toBe(2040);
        expect((textBlock.box as Record<string, unknown>).width).toBe(2040);
      }
    });

    it('cover entry imageBlock.imageUrl matches the cover image from imageGenerationResult', async () => {
      const book = makeBook({ childName: 'Mia', theme: 'friendship' });
      setupMocks();

      await runGeneration(service, prisma, book);

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

      await runGeneration(service, prisma, book);

      const updateArg = prisma.book.update.mock.calls[0]?.[0];
      const preview = updateArg?.data?.bookPreview as Record<string, unknown>;
      const layout = updateArg?.data?.bookLayout as Record<string, unknown>;
      const meta = layout.metadata as Record<string, unknown>;
      expect(meta.title).toBe(preview.title);
    });

    it('bookLayout.metadata.childName equals the book childName', async () => {
      const book = makeBook({ childName: 'Mia', theme: 'friendship' });
      setupMocks();

      await runGeneration(service, prisma, book);

      const updateArg = prisma.book.update.mock.calls[0]?.[0];
      const layout = updateArg?.data?.bookLayout as Record<string, unknown>;
      const meta = layout.metadata as Record<string, unknown>;
      expect(meta.childName).toBe('Mia');
    });

    it('bookLayout is deterministic for the same input', async () => {
      const book = makeBook({ childName: 'Mia', theme: 'friendship' });
      setupMocks();
      await runGeneration(service, prisma, book);
      const firstArg = prisma.book.update.mock.calls[0]?.[0];
      const firstLayout = firstArg?.data?.bookLayout as Record<string, unknown>;
      const firstEntries = (firstLayout.entries as Array<Record<string, unknown>>).map((e) => e.id);

      prisma.book.update.mockClear();
      prisma.agentLog.createMany.mockClear();
      setupMocks();
      await runGeneration(service, prisma, book);
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

      await runGeneration(service, prisma, book);

      expect(renderStorybookPdf).toHaveBeenCalledOnce();
    });

    it('calls pdfStorage.saveClaimPreviewPdf with the book id, the current claim namespace, and the rendered buffer', async () => {
      const book = makeBook();
      setupMocks();
      const mockBuffer = Buffer.from('%PDF-1.4 mock');
      vi.mocked(renderStorybookPdf).mockResolvedValue(mockBuffer);

      await runGeneration(service, prisma, book);

      expect(mockPdfStorage.saveClaimPreviewPdf).toHaveBeenCalledWith(
        'b-1',
        claimNs(RUN_1, 1),
        mockBuffer,
      );
    });

    it('never calls the legacy pdfStorage.savePreviewPdf for a new generation', async () => {
      const book = makeBook();
      setupMocks();

      await runGeneration(service, prisma, book);

      expect(mockPdfStorage.savePreviewPdf).not.toHaveBeenCalled();
    });

    it('two claims of the same run use distinct PDF keys (fencingVersion, not just runId, disambiguates)', async () => {
      const book = makeBook();
      setupMocks();
      await runGeneration(service, prisma, book, 'hash-1', { runId: RUN_1, fencingVersion: 1 });
      const firstNamespace = mockPdfStorage.saveClaimPreviewPdf.mock.calls[0]?.[1];

      mockPdfStorage.saveClaimPreviewPdf.mockClear();
      prisma.book.update.mockClear();
      prisma.agentLog.createMany.mockClear();
      setupMocks();
      await runGeneration(service, prisma, book, 'hash-1', { runId: RUN_1, fencingVersion: 2 });
      const secondNamespace = mockPdfStorage.saveClaimPreviewPdf.mock.calls[0]?.[1];

      expect(firstNamespace).toEqual(claimNs(RUN_1, 1));
      expect(secondNamespace).toEqual(claimNs(RUN_1, 2));
      expect(firstNamespace).not.toEqual(secondNamespace);
    });

    it('resolves a completed GenerationOutcome on success', async () => {
      const book = makeBook();
      setupMocks();

      const result = await runGeneration(service, prisma, book);

      expect(result.status).toBe('complete');
      expect(result.bookUpdate).not.toHaveProperty('status');
    });

    it('persists previewPdfUrl from storage result on the outcome', async () => {
      const book = makeBook();
      setupMocks();

      const result = await runGeneration(service, prisma, book);

      expect(result.bookUpdate.previewPdfUrl).toBe(
        '/files/books/b-1/runs/run-1/claims/1/storyme-preview-b-1.pdf',
      );
    });

    it('pdf_render AgentLog entry has status success on happy path', async () => {
      const book = makeBook();
      setupMocks();

      const result = await runGeneration(service, prisma, book);

      const entries = result.agentLogs as unknown as Array<Record<string, unknown>>;
      const pdfEntry = entries.find((e) => e.step === 'pdf_render');
      expect(pdfEntry?.status).toBe('success');
    });

    it('marks book as failed when renderStorybookPdf throws', async () => {
      const book = makeBook();
      setupMocks();
      vi.mocked(renderStorybookPdf).mockRejectedValue(new Error('PDF engine crashed'));

      const result = await runGeneration(service, prisma, book);

      expect(result.status).toBe('failed');
    });

    it('does not set previewPdfUrl when PDF render fails', async () => {
      const book = makeBook();
      setupMocks();
      vi.mocked(renderStorybookPdf).mockRejectedValue(new Error('render error'));

      const result = await runGeneration(service, prisma, book);

      expect(result.bookUpdate).not.toHaveProperty('previewPdfUrl');
    });

    it('persists errorMessage and failedStep when PDF render fails', async () => {
      const book = makeBook();
      setupMocks();
      vi.mocked(renderStorybookPdf).mockRejectedValue(new Error('PDFKit failure'));

      const result = await runGeneration(service, prisma, book);

      expect(result.errorMessage).toBe('PDFKit failure');
      expect(result.failedStep).toBe('pdf_render');
    });

    it('pdf_render AgentLog entry has status error when render fails', async () => {
      const book = makeBook();
      setupMocks();
      vi.mocked(renderStorybookPdf).mockRejectedValue(new Error('render error'));

      const result = await runGeneration(service, prisma, book);

      const entries = result.agentLogs as unknown as Array<Record<string, unknown>>;
      const pdfEntry = entries.find((e) => e.step === 'pdf_render');
      expect(pdfEntry?.status).toBe('error');
      expect(typeof pdfEntry?.error).toBe('string');
    });

    it('does not mark book complete when PDF render fails', async () => {
      const book = makeBook();
      setupMocks();
      vi.mocked(renderStorybookPdf).mockRejectedValue(new Error('boom'));

      const result = await runGeneration(service, prisma, book);

      expect(result.status).not.toBe('complete');
    });

    // ── Phase 2M: Storage failure ─────────────────────────────────────────────

    it('marks book as failed when pdfStorage.saveClaimPreviewPdf throws', async () => {
      const book = makeBook();
      setupMocks();
      mockPdfStorage.saveClaimPreviewPdf.mockRejectedValue(new Error('disk full'));

      const result = await runGeneration(service, prisma, book);

      expect(result.status).toBe('failed');
    });

    it('does not mark book complete when storage fails', async () => {
      const book = makeBook();
      setupMocks();
      mockPdfStorage.saveClaimPreviewPdf.mockRejectedValue(new Error('storage error'));

      const result = await runGeneration(service, prisma, book);

      expect(result.status).not.toBe('complete');
    });

    it('does not persist previewPdfUrl when storage fails', async () => {
      const book = makeBook();
      setupMocks();
      mockPdfStorage.saveClaimPreviewPdf.mockRejectedValue(new Error('storage error'));

      const result = await runGeneration(service, prisma, book);

      expect(result.bookUpdate).not.toHaveProperty('previewPdfUrl');
    });

    it('persists errorMessage and failedStep when storage fails', async () => {
      const book = makeBook();
      setupMocks();
      mockPdfStorage.saveClaimPreviewPdf.mockRejectedValue(new Error('disk full'));

      const result = await runGeneration(service, prisma, book);

      expect(result.errorMessage).toBe('disk full');
      expect(result.failedStep).toBe('pdf_render');
    });

    it('pdf_render AgentLog entry has status error when storage fails', async () => {
      const book = makeBook();
      setupMocks();
      mockPdfStorage.saveClaimPreviewPdf.mockRejectedValue(new Error('write failed'));
      prisma.book.update.mockReset();
      prisma.book.update
        .mockResolvedValueOnce(makeBook({ status: 'layout' as Book['status'] }))
        .mockResolvedValueOnce(makeBook({ status: 'failed' as Book['status'] }));

      const result = await runGeneration(service, prisma, book);

      const entries = result.agentLogs as unknown as Array<Record<string, unknown>>;
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
          new MockCharacterProfileProvider(),
          generationExecutionService as never,
        );
      }

      it('resolves a failed GenerationOutcome with the provider error message, without writing status/errorMessage/failedStep to Book itself', async () => {
        const book = makeBook();
        const failingService = makeFailingService('LLM provider unavailable');

        const result = await runGeneration(failingService, prisma, book);

        expect(result.status).toBe('failed');
        expect(result.errorMessage).toBe('LLM provider unavailable');
        expect(result.failedStep).toBe('story_plan');
        expect(result.bookUpdate).toEqual({
          generationTimeMs: expect.any(Number),
          aiModelVersions: { story: 'unknown', image: 'mock' },
          characterProfile: expect.any(Object),
          characterSheetAssetKey: expect.any(String),
        });
        // Never written by AgentService itself — see GenerationOutcome's doc
        // comment; the coordinator applies these atomically instead.
        expect(prisma.book.update).not.toHaveBeenCalled();
      });

      it('does not attempt to save per-page/cover image assets, build layout, or render a PDF (the char_build character sheet still saves, independent of story generation)', async () => {
        const book = makeBook();
        const failingService = makeFailingService('boom');

        await runGeneration(failingService, prisma, book);

        expect(mockImageAssetStorage.saveImageAsset).toHaveBeenCalledTimes(1);
        expect(mockImageAssetStorage.saveImageAsset).toHaveBeenCalledWith(
          sheetKey(RUN_1),
          expect.any(Buffer),
          'image/png',
        );
        expect(renderStorybookPdf).not.toHaveBeenCalled();
        expect(mockPdfStorage.savePreviewPdf).not.toHaveBeenCalled();
        expect(prisma.book.update).not.toHaveBeenCalled();
      });

      it('returns a char_build AgentLog entry plus a story_plan AgentLog entry with status error on the outcome', async () => {
        const book = makeBook();
        const failingService = makeFailingService('bad prompt');

        const result = await runGeneration(failingService, prisma, book);

        const entries = result.agentLogs as unknown as Array<Record<string, unknown>>;
        expect(entries).toHaveLength(2);
        const charBuildEntry = entries.find((e) => e.step === 'char_build');
        expect(charBuildEntry?.status).toBe('success');
        const storyPlanEntry = entries.find((e) => e.step === 'story_plan');
        expect(storyPlanEntry?.status).toBe('error');
        expect(storyPlanEntry?.error).toBe('bad prompt');
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
          new MockCharacterProfileProvider(),
          generationExecutionService as never,
        );

        await runGeneration(spyingService, prisma, book);

        expect(generateStory).toHaveBeenCalledWith({
          bookId: 'b-1',
          childName: 'Mia',
          childAge: 5,
          theme: 'friendship',
          language: 'en',
          characterProfile: expect.any(Object),
        });
      });
    });

    // ── Phase 3E: generation diagnostics metadata ─────────────────────────────

    describe('generation diagnostics metadata', () => {
      it('records generationTimeMs and aiModelVersions on the final update when generation succeeds', async () => {
        const book = makeBook();
        setupMocks();

        const result = await runGeneration(service, prisma, book);

        expect(result.bookUpdate.generationTimeMs).toEqual(expect.any(Number));
        expect(result.bookUpdate.aiModelVersions).toEqual({ story: 'mock', image: 'mock' });
      });

      it('tags every AgentLog entry with provider/model from the injected providers', async () => {
        const book = makeBook();
        setupMocks();

        const result = await runGeneration(service, prisma, book);

        const entries = result.agentLogs as unknown as Array<Record<string, unknown>>;
        const storyEntry = entries.find((e) => e.step === 'story_plan');
        const imageEntry = entries.find((e) => e.step === 'image_gen');
        expect(storyEntry?.provider).toBe('mock');
        expect(imageEntry?.provider).toBe('mock');
      });

      it('records durationMs on the story_plan, image_gen, layout, and pdf_render AgentLog entries', async () => {
        const book = makeBook();
        setupMocks();

        const result = await runGeneration(service, prisma, book);

        const entries = result.agentLogs as unknown as Array<Record<string, unknown>>;
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
          new MockCharacterProfileProvider(),
          generationExecutionService as never,
        );

        const result = await runGeneration(openaiService, prisma, book);

        expect(result.bookUpdate.aiModelVersions).toEqual({
          story: 'gpt-4o-mini',
          image: 'mock',
        });
        const entries = result.agentLogs as unknown as Array<Record<string, unknown>>;
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

        await runGeneration(service, prisma, book);

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

        await runGeneration(service, prisma, book);

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

        await runGeneration(service, prisma, book);

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

      it('rejects a provider result when its image plan is missing a page', async () => {
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
          new MockCharacterProfileProvider(),
          generationExecutionService as never,
        );

        const outcome = await runGeneration(serviceWithGap, prisma, book);

        expect(outcome).toMatchObject({
          status: 'failed',
          failedStep: 'story_plan',
          errorCode: 'GENERATION_FAILED',
        });
        expect(outcome.errorMessage).toContain('image plan must contain exactly one cover');
        expect(prisma.book.update).not.toHaveBeenCalled();
      });
    });
  });

  // ── Phase B, Slice B3: claim-scoped artifact pointer ──────────────────────
  describe('claim-scoped artifact pointer (Book.lastGenerationRunId/lastGenerationFencingVersion)', () => {
    it('atomically persists lastGenerationRunId/lastGenerationFencingVersion alongside the resumable JSON at the Phase 1 write', async () => {
      const book = makeBook();
      const layoutBook = makeBook({ status: 'layout' as Book['status'] });
      const completedBook = makeBook({
        status: 'complete' as Book['status'],
        previewPdfUrl: '/files/books/b-1/storybook.pdf',
      });
      prisma.book.update.mockResolvedValueOnce(layoutBook).mockResolvedValueOnce(completedBook);
      prisma.agentLog.createMany.mockResolvedValue({ count: 9 });

      await runGeneration(service, prisma, book, 'the-run-inputhash', {
        runId: 'run-42',
        fencingVersion: 7,
      });

      expect(prisma.book.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            lastGenerationRunId: 'run-42',
            lastGenerationFencingVersion: 7,
            lastGenerationInputHash: 'the-run-inputhash',
          }),
        }),
      );
    });

    it('throws — never silently falls back to legacy — when Book carries a malformed partial artifact pointer', async () => {
      const book = makeBook({
        lastGenerationRunId: 'some-run-id',
        lastGenerationFencingVersion: null,
      });
      prisma.book.findUniqueOrThrow.mockResolvedValue(book);

      await expect(service.startBookGeneration(ctxFor(book))).rejects.toThrow(
        InvalidGenerationArtifactPointerError,
      );
      expect(prisma.book.update).not.toHaveBeenCalled();
    });
  });

  // ── Idempotent resume of a partially generated book ───────────────────────
  describe('idempotent resume (retrying a book that already has some generated assets)', () => {
    // Simulates a real retry's inputHash — copied verbatim from the failed
    // run being retried (see BooksService.retryGeneration), so it always
    // equals whatever hash the original successful phase-1 persist recorded
    // in Book.lastGenerationInputHash. Tests that want to exercise a
    // *changed* input (regenerate-after-edit) pass a different value.
    const FIXED_INPUT_HASH = 'stable-test-input-hash';

    function makeSpyStoryProvider(): StoryGenerationProvider & {
      generateStory: ReturnType<typeof vi.fn>;
    } {
      const real = new MockStoryGenerationProvider();
      return {
        providerName: real.providerName,
        generateStory: vi.fn((input) => real.generateStory(input)),
      };
    }

    function makeSpyCharacterProfileProvider(): CharacterProfileProvider & {
      buildProfile: ReturnType<typeof vi.fn>;
    } {
      const real = new MockCharacterProfileProvider();
      return {
        providerName: real.providerName,
        buildProfile: vi.fn((input) => real.buildProfile(input)),
      };
    }

    function makeSpyImageProvider(): ImageGenerationProvider & {
      generateImage: ReturnType<typeof vi.fn>;
      generateCharacterSheet: ReturnType<typeof vi.fn>;
    } {
      const real = new MockImageGenerationProvider();
      return {
        providerName: real.providerName,
        generateImage: vi.fn((input) => real.generateImage(input)),
        generateCharacterSheet: vi.fn((input) => real.generateCharacterSheet(input)),
      };
    }

    /** Runs one full fresh generation with spy-wrapped providers and returns the Phase 1 persisted payload (storyPlan/characterCard/bookPreview/imageGenerationResult/characterProfile/characterSheetAssetKey) — a realistic prior-run state to resume from. */
    async function generateFreshBook(): Promise<Record<string, unknown>> {
      const book = makeBook();
      const layoutBook = makeBook({ status: 'layout' as Book['status'] });
      const completedBook = makeBook({
        status: 'complete' as Book['status'],
        previewPdfUrl: '/files/books/b-1/storybook.pdf',
      });
      prisma.book.update.mockResolvedValueOnce(layoutBook).mockResolvedValueOnce(completedBook);
      prisma.agentLog.createMany.mockResolvedValue({ count: 9 });

      const freshService = new AgentService(
        prisma as never,
        mockPdfStorage as unknown as PdfStorage,
        mockImageAssetStorage as unknown as ImageAssetStorage,
        makeSpyStoryProvider(),
        makeSpyImageProvider(),
        makeSpyCharacterProfileProvider(),
        generationExecutionService as never,
      );
      await runGeneration(freshService, prisma, book, FIXED_INPUT_HASH);
      return prisma.book.update.mock.calls[0]?.[0]?.data as Record<string, unknown>;
    }

    /** Builds a `failed` book row carrying the given prior-run state, as retryGeneration leaves it (storyPlan/characterCard/etc. are never cleared — see books.service.ts). */
    function makeResumedBook(
      persisted: Record<string, unknown>,
      overrides: Partial<Book> = {},
    ): Book {
      return makeBook({
        status: 'failed' as Book['status'],
        failedStep: 'pdf_render' as Book['failedStep'],
        errorMessage: 'Cannot render PDF: missing generated illustration(s) for back_cover.',
        storyPlan: persisted.storyPlan as Book['storyPlan'],
        characterCard: persisted.characterCard as Book['characterCard'],
        bookPreview: persisted.bookPreview as Book['bookPreview'],
        imageGenerationResult: persisted.imageGenerationResult as Book['imageGenerationResult'],
        characterProfile: persisted.characterProfile as Book['characterProfile'],
        characterSheetAssetKey: (persisted.characterSheetAssetKey as string | undefined) ?? null,
        lastGenerationInputHash: (persisted.lastGenerationInputHash as string | undefined) ?? null,
        // The Book pointer Phase 1 now persists atomically alongside the
        // resumable JSON (Phase B, Slice B3) — this is what lets a resumed
        // attempt (a different claim, RUN_2 below) resolve RUN_1's claim as
        // its copy-forward source instead of guessing from a positional key.
        lastGenerationRunId: (persisted.lastGenerationRunId as string | undefined) ?? null,
        lastGenerationFencingVersion:
          (persisted.lastGenerationFencingVersion as number | undefined) ?? null,
        ...overrides,
      });
    }

    function setupResumeMocks() {
      const layoutBook = makeBook({ status: 'layout' as Book['status'] });
      const completedBook = makeBook({
        status: 'complete' as Book['status'],
        previewPdfUrl: '/files/books/b-1/storybook.pdf',
      });
      prisma.book.update.mockReset();
      prisma.book.update.mockResolvedValueOnce(layoutBook).mockResolvedValueOnce(completedBook);
      prisma.agentLog.createMany.mockReset();
      prisma.agentLog.createMany.mockResolvedValue({ count: 9 });
      mockPdfStorage.saveClaimPreviewPdf.mockResolvedValue({
        url: '/files/books/b-1/runs/run-2/claims/1/storyme-preview-b-1.pdf',
        path: '/api/tmp/books/b-1/runs/run-2/claims/1/storyme-preview-b-1.pdf',
      });
      vi.mocked(renderStorybookPdf).mockResolvedValue(Buffer.from('%PDF-1.4 mock'));
      // Clears call history left over from generateFreshBook() above (the
      // savedAssets Map itself is untouched) so assertions in the resume
      // phase only see calls made during the resume run.
      mockImageAssetStorage.saveImageAsset.mockClear();
      mockImageAssetStorage.getImageAsset.mockClear();
    }

    it('reuses the cover and all six page images, makes exactly one image-provider call for back_cover, renders the PDF, and completes', async () => {
      const persisted = await generateFreshBook();
      savedAssets.delete(imgKey(RUN_1, 'back_cover'));
      setupResumeMocks();

      const resumedBook = makeResumedBook(persisted);
      const storyProvider = makeSpyStoryProvider();
      const profileProvider = makeSpyCharacterProfileProvider();
      const imageProvider = makeSpyImageProvider();
      const resumeService = new AgentService(
        prisma as never,
        mockPdfStorage as unknown as PdfStorage,
        mockImageAssetStorage as unknown as ImageAssetStorage,
        storyProvider,
        imageProvider,
        profileProvider,
        generationExecutionService as never,
      );

      const result = await runGeneration(resumeService, prisma, resumedBook, FIXED_INPUT_HASH, {
        runId: RUN_2,
      });

      expect(storyProvider.generateStory).not.toHaveBeenCalled();
      expect(profileProvider.buildProfile).not.toHaveBeenCalled();
      expect(imageProvider.generateCharacterSheet).not.toHaveBeenCalled();
      expect(imageProvider.generateImage).toHaveBeenCalledTimes(1);
      expect(imageProvider.generateImage).toHaveBeenCalledWith(
        expect.objectContaining({ entry: expect.objectContaining({ kind: 'back_cover' }) }),
      );
      // The 7 reused images plus the character sheet are copy-forwarded from
      // RUN_1 (never through saveImageAsset); only the regenerated
      // back_cover is freshly saved, and it lands under RUN_2 — the current
      // claim, not RUN_1.
      expect(mockImageAssetStorage.copyImageAsset).toHaveBeenCalledTimes(8);
      expect(mockImageAssetStorage.saveImageAsset).toHaveBeenCalledWith(
        imgKey(RUN_2, 'back_cover'),
        expect.any(Buffer),
        expect.any(String),
      );
      expect(savedAssets.get(imgKey(RUN_2, 'cover'))).toBeDefined();
      expect(renderStorybookPdf).toHaveBeenCalled();
      expect(result.status).toBe('complete');
    });

    it('does NOT resume — regenerates the story, character profile, and every image — when the run inputHash does not match Book.lastGenerationInputHash (the book was edited since the persisted result)', async () => {
      const persisted = await generateFreshBook();
      // Deliberately leave the back_cover asset (and everything else) present
      // in storage — the whole point of this test is that a changed input
      // must ignore that prior content entirely, not just fill a gap in it.
      setupResumeMocks();

      const resumedBook = makeResumedBook(persisted);
      const storyProvider = makeSpyStoryProvider();
      const profileProvider = makeSpyCharacterProfileProvider();
      const imageProvider = makeSpyImageProvider();
      const resumeService = new AgentService(
        prisma as never,
        mockPdfStorage as unknown as PdfStorage,
        mockImageAssetStorage as unknown as ImageAssetStorage,
        storyProvider,
        imageProvider,
        profileProvider,
        generationExecutionService as never,
      );

      await runGeneration(resumeService, prisma, resumedBook, 'a-completely-different-input-hash', {
        runId: RUN_2,
      });

      // Story/character profile must be regenerated from scratch — reusing
      // them here is exactly the stale-content bug this hash gate fixes.
      expect(storyProvider.generateStory).toHaveBeenCalledOnce();
      expect(profileProvider.buildProfile).toHaveBeenCalledOnce();
      expect(imageProvider.generateCharacterSheet).toHaveBeenCalledOnce();
      // Every planned image is regenerated too (cover + 6 pages + back
      // cover = 8) — even though RUN_1's claim (a valid, distinct copy-forward
      // source per Book.lastGenerationRunId/FencingVersion) still has every
      // byte present, a changed input must never copy any of it forward into
      // RUN_2's claim.
      expect(imageProvider.generateImage).toHaveBeenCalledTimes(8);
      expect(mockImageAssetStorage.copyImageAsset).not.toHaveBeenCalled();
      for (const key of [
        imgKey(RUN_2, 'cover'),
        ...Array.from({ length: 6 }, (_, i) => imgKey(RUN_2, 'page', i + 1)),
        imgKey(RUN_2, 'back_cover'),
      ]) {
        expect(mockImageAssetStorage.saveImageAsset).toHaveBeenCalledWith(
          key,
          expect.any(Buffer),
          expect.any(String),
        );
      }
    });

    it('copies a valid legacy-positional source image and character sheet into the current claim namespace for a book that predates Phase B (both pointer fields null)', async () => {
      const persisted = await generateFreshBook();
      const imageResult = persisted.imageGenerationResult as {
        images: Array<{ kind: 'cover' | 'page' | 'back_cover'; pageNumber?: number }>;
      };
      // Legacy positional bytes — pre-Phase-B rows never had a claim
      // namespace at all, so the source lives at the plain
      // imageAssetKey/characterSheetAssetKey path, not under books/.../claims/....
      for (const image of imageResult.images) {
        savedAssets.set(
          imageAssetKey('b-1', image.kind, image.pageNumber),
          Buffer.from(`legacy-${image.kind}-${image.pageNumber ?? ''}`),
        );
      }
      savedAssets.set(characterSheetAssetKey('b-1'), Buffer.from('legacy-sheet'));
      setupResumeMocks();

      const resumedBook = makeResumedBook(persisted, {
        lastGenerationRunId: null,
        lastGenerationFencingVersion: null,
      });
      const storyProvider = makeSpyStoryProvider();
      const profileProvider = makeSpyCharacterProfileProvider();
      const imageProvider = makeSpyImageProvider();
      const resumeService = new AgentService(
        prisma as never,
        mockPdfStorage as unknown as PdfStorage,
        mockImageAssetStorage as unknown as ImageAssetStorage,
        storyProvider,
        imageProvider,
        profileProvider,
        generationExecutionService as never,
      );

      const result = await runGeneration(resumeService, prisma, resumedBook, FIXED_INPUT_HASH, {
        runId: RUN_2,
      });

      expect(storyProvider.generateStory).not.toHaveBeenCalled();
      expect(imageProvider.generateImage).not.toHaveBeenCalled();
      expect(imageProvider.generateCharacterSheet).not.toHaveBeenCalled();
      expect(mockImageAssetStorage.copyImageAsset).toHaveBeenCalledWith(
        imageAssetKey('b-1', 'cover'),
        imgKey(RUN_2, 'cover'),
      );
      expect(mockImageAssetStorage.copyImageAsset).toHaveBeenCalledWith(
        characterSheetAssetKey('b-1'),
        sheetKey(RUN_2),
      );
      expect(savedAssets.get(imgKey(RUN_2, 'cover'))).toBeDefined();
      expect(result.status).toBe('complete');
    });

    it('copies from a prior claim of the same run (a stalled-redelivery reclaim bumps fencingVersion, not runId)', async () => {
      const persisted = await generateFreshBook();
      setupResumeMocks();

      const resumedBook = makeResumedBook(persisted);
      const imageProvider = makeSpyImageProvider();
      const resumeService = new AgentService(
        prisma as never,
        mockPdfStorage as unknown as PdfStorage,
        mockImageAssetStorage as unknown as ImageAssetStorage,
        makeSpyStoryProvider(),
        imageProvider,
        makeSpyCharacterProfileProvider(),
        generationExecutionService as never,
      );

      // Same runId as the source claim (RUN_1), but a higher fencingVersion —
      // exactly what GenerationRunService.claim produces on a stalled
      // redelivery of the same GenerationRun.
      const result = await runGeneration(resumeService, prisma, resumedBook, FIXED_INPUT_HASH, {
        runId: RUN_1,
        fencingVersion: 2,
      });

      expect(imageProvider.generateImage).not.toHaveBeenCalled();
      expect(mockImageAssetStorage.copyImageAsset).toHaveBeenCalledWith(
        imgKey(RUN_1, 'cover', undefined, 1),
        imgKey(RUN_1, 'cover', undefined, 2),
      );
      expect(result.status).toBe('complete');
    });

    it('folds resumeMode/reusedImageCount/regeneratedImageCount/skipped* diagnostics onto imageGenerationResult.resume', async () => {
      const persisted = await generateFreshBook();
      savedAssets.delete(imgKey(RUN_1, 'back_cover'));
      setupResumeMocks();

      const resumedBook = makeResumedBook(persisted);
      const resumeService = new AgentService(
        prisma as never,
        mockPdfStorage as unknown as PdfStorage,
        mockImageAssetStorage as unknown as ImageAssetStorage,
        makeSpyStoryProvider(),
        makeSpyImageProvider(),
        makeSpyCharacterProfileProvider(),
        generationExecutionService as never,
      );

      const result = await runGeneration(resumeService, prisma, resumedBook, FIXED_INPUT_HASH, {
        runId: RUN_2,
      });

      const persistedResult = result.bookUpdate.imageGenerationResult as unknown as {
        resume?: Record<string, unknown>;
      };
      const resume = persistedResult.resume;
      expect(resume).toBeDefined();
      expect(resume?.resumeMode).toBe(true);
      expect(resume?.reusedImageCount).toBe(7);
      expect(resume?.regeneratedImageCount).toBe(1);
      expect(resume?.skippedStoryGeneration).toBe(true);
      expect(resume?.skippedCharacterProfileGeneration).toBe(true);
      expect(resume?.skippedCharacterSheetGeneration).toBe(true);
      expect(resume?.skippedExistingImageGeneration).toBe(true);
      expect(resume?.pdfRenderAttempted).toBe(true);
      expect(resume?.pdfRenderSucceeded).toBe(true);
      expect(resume?.finalBookStatus).toBe('complete');
      // The prior run never reached a successful PDF render, so 'pdf' is
      // also missing going into this retry (see resumedBook's overrides).
      expect(resume?.missingAssetsBeforeRetry).toEqual(['back_cover', 'pdf']);
      expect(resume?.missingAssetsAfterRetry).toEqual([]);
    });

    it('treats a database asset record whose local file is missing as invalid and regenerates it', async () => {
      const persisted = await generateFreshBook();
      savedAssets.delete(imgKey(RUN_1, 'page', 3));
      setupResumeMocks();

      const resumedBook = makeResumedBook(persisted, {
        errorMessage: 'Cannot render PDF: missing generated illustration(s) for page 3.',
      });
      const imageProvider = makeSpyImageProvider();
      const resumeService = new AgentService(
        prisma as never,
        mockPdfStorage as unknown as PdfStorage,
        mockImageAssetStorage as unknown as ImageAssetStorage,
        makeSpyStoryProvider(),
        imageProvider,
        makeSpyCharacterProfileProvider(),
        generationExecutionService as never,
      );

      await runGeneration(resumeService, prisma, resumedBook, FIXED_INPUT_HASH, { runId: RUN_2 });

      expect(imageProvider.generateImage).toHaveBeenCalledTimes(1);
      expect(imageProvider.generateImage).toHaveBeenCalledWith(
        expect.objectContaining({
          entry: expect.objectContaining({ kind: 'page', pageNumber: 3 }),
        }),
      );
    });

    it('treats a zero-byte local file as invalid and regenerates it', async () => {
      const persisted = await generateFreshBook();
      savedAssets.set(imgKey(RUN_1, 'page', 5), Buffer.alloc(0));
      setupResumeMocks();

      const resumedBook = makeResumedBook(persisted, {
        errorMessage: 'Cannot render PDF: missing generated illustration(s) for page 5.',
      });
      const imageProvider = makeSpyImageProvider();
      const resumeService = new AgentService(
        prisma as never,
        mockPdfStorage as unknown as PdfStorage,
        mockImageAssetStorage as unknown as ImageAssetStorage,
        makeSpyStoryProvider(),
        imageProvider,
        makeSpyCharacterProfileProvider(),
        generationExecutionService as never,
      );

      await runGeneration(resumeService, prisma, resumedBook, FIXED_INPUT_HASH, { runId: RUN_2 });

      expect(imageProvider.generateImage).toHaveBeenCalledTimes(1);
      expect(imageProvider.generateImage).toHaveBeenCalledWith(
        expect.objectContaining({
          entry: expect.objectContaining({ kind: 'page', pageNumber: 5 }),
        }),
      );
    });

    it('makes zero image-provider requests and no story/profile calls when retrying an already fully generated book', async () => {
      const persisted = await generateFreshBook();
      // Nothing deleted from savedAssets — every asset from the first run is still valid.
      setupResumeMocks();

      const resumedBook = makeResumedBook(persisted, {
        status: 'complete' as Book['status'],
        failedStep: null,
        errorMessage: null,
        previewPdfUrl: '/files/books/b-1/storybook.pdf',
      });
      const storyProvider = makeSpyStoryProvider();
      const profileProvider = makeSpyCharacterProfileProvider();
      const imageProvider = makeSpyImageProvider();
      const resumeService = new AgentService(
        prisma as never,
        mockPdfStorage as unknown as PdfStorage,
        mockImageAssetStorage as unknown as ImageAssetStorage,
        storyProvider,
        imageProvider,
        profileProvider,
        generationExecutionService as never,
      );

      const result = await runGeneration(resumeService, prisma, resumedBook, FIXED_INPUT_HASH, {
        runId: RUN_2,
      });

      expect(storyProvider.generateStory).not.toHaveBeenCalled();
      expect(profileProvider.buildProfile).not.toHaveBeenCalled();
      expect(imageProvider.generateCharacterSheet).not.toHaveBeenCalled();
      expect(imageProvider.generateImage).not.toHaveBeenCalled();
      // A complete mixture: every entry here is copy-forwarded (cover + 6
      // pages + back_cover + the character sheet = 9), leaving RUN_2 a
      // single self-contained claim assembled entirely from RUN_1's bytes.
      expect(mockImageAssetStorage.copyImageAsset).toHaveBeenCalledTimes(9);
      expect(mockImageAssetStorage.saveImageAsset).not.toHaveBeenCalled();
      expect(result.status).toBe('complete');
    });

    it('leaves valid existing assets untouched when the regenerated asset fails again', async () => {
      const persisted = await generateFreshBook();
      savedAssets.delete(imgKey(RUN_1, 'back_cover'));
      setupResumeMocks();

      const resumedBook = makeResumedBook(persisted);
      const failingImageProvider: ImageGenerationProvider = {
        providerName: 'mock',
        generateImage: vi.fn().mockRejectedValue(new Error('back_cover request failed again')),
        generateCharacterSheet: vi.fn(),
      };
      const warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const resumeService = new AgentService(
        prisma as never,
        mockPdfStorage as unknown as PdfStorage,
        mockImageAssetStorage as unknown as ImageAssetStorage,
        makeSpyStoryProvider(),
        failingImageProvider,
        makeSpyCharacterProfileProvider(),
        generationExecutionService as never,
      );

      const result = await runGeneration(resumeService, prisma, resumedBook, FIXED_INPUT_HASH, {
        runId: RUN_2,
      });

      // The 7 previously valid assets are copy-forwarded, never re-requested
      // from the provider or written via saveImageAsset.
      expect(failingImageProvider.generateImage).toHaveBeenCalledTimes(1);
      expect(mockImageAssetStorage.saveImageAsset).not.toHaveBeenCalledWith(
        imgKey(RUN_2, 'cover'),
        expect.anything(),
        expect.anything(),
      );
      for (let n = 1; n <= 6; n++) {
        expect(mockImageAssetStorage.saveImageAsset).not.toHaveBeenCalledWith(
          imgKey(RUN_2, 'page', n),
          expect.anything(),
          expect.anything(),
        );
      }
      // Both the source (RUN_1) and the copied-forward current claim (RUN_2)
      // have the cover bytes — copy-forward for the other entries completed
      // independently of the back_cover provider failure.
      expect(savedAssets.get(imgKey(RUN_1, 'cover'))).toBeDefined();
      expect(savedAssets.get(imgKey(RUN_2, 'cover'))).toBeDefined();
      expect(result.status).toBe('failed');
      expect(result.failedStep).toBe('pdf_render');
      warnSpy.mockRestore();
    });

    // ── Diagnose and fix a failed resumed back_cover generation ────────────

    it('passes the stored character-reference bytes to the resumed back_cover request and reports character-reference-edit mode even though the request failed', async () => {
      const persisted = await generateFreshBook();
      savedAssets.delete(imgKey(RUN_1, 'back_cover'));
      setupResumeMocks();

      const resumedBook = makeResumedBook(persisted);
      const failingImageProvider: ImageGenerationProvider = {
        providerName: 'openai',
        modelName: 'gpt-image-1',
        generateImage: vi.fn().mockRejectedValue(new Error('back_cover request failed again')),
        generateCharacterSheet: vi.fn(),
      };
      const warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const resumeService = new AgentService(
        prisma as never,
        mockPdfStorage as unknown as PdfStorage,
        mockImageAssetStorage as unknown as ImageAssetStorage,
        makeSpyStoryProvider(),
        failingImageProvider,
        makeSpyCharacterProfileProvider(),
        generationExecutionService as never,
      );

      const outcome = await runGeneration(resumeService, prisma, resumedBook, FIXED_INPUT_HASH, {
        runId: RUN_2,
      });

      expect(failingImageProvider.generateImage).toHaveBeenCalledTimes(1);
      const call = failingImageProvider.generateImage.mock.calls[0]![0] as {
        characterReference?: { buffer: Buffer };
      };
      expect(call.characterReference).toBeDefined();
      // Read back from RUN_2 — the current claim's copied-forward sheet —
      // never RUN_1 directly, proving the reference passed to the provider
      // came from the self-contained current claim.
      expect(call.characterReference!.buffer.equals(savedAssets.get(sheetKey(RUN_2))!)).toBe(true);

      const result = outcome.bookUpdate.imageGenerationResult as unknown as {
        imageGenerationMode?: string;
        resume?: { regeneratedImageCount?: number };
        imageFailures?: Array<Record<string, unknown>>;
      };
      expect(result.imageGenerationMode).toBe('character-reference-edit');
      expect(result.resume?.regeneratedImageCount).toBe(0);
      warnSpy.mockRestore();
    });

    it('records a safe per-asset imageFailures diagnostic for the failed resumed back_cover request', async () => {
      const persisted = await generateFreshBook();
      savedAssets.delete(imgKey(RUN_1, 'back_cover'));
      setupResumeMocks();

      const resumedBook = makeResumedBook(persisted);
      const failingImageProvider: ImageGenerationProvider = {
        providerName: 'openai',
        modelName: 'gpt-image-1',
        generateImage: vi.fn().mockRejectedValue(new Error('back_cover request failed again')),
        generateCharacterSheet: vi.fn(),
      };
      const warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const resumeService = new AgentService(
        prisma as never,
        mockPdfStorage as unknown as PdfStorage,
        mockImageAssetStorage as unknown as ImageAssetStorage,
        makeSpyStoryProvider(),
        failingImageProvider,
        makeSpyCharacterProfileProvider(),
        generationExecutionService as never,
      );

      const outcome = await runGeneration(resumeService, prisma, resumedBook, FIXED_INPUT_HASH, {
        runId: RUN_2,
      });

      const result = outcome.bookUpdate.imageGenerationResult as unknown as {
        imageFailures?: Array<Record<string, unknown>>;
      };
      expect(result.imageFailures).toHaveLength(1);
      const failure = result.imageFailures![0]!;
      expect(failure.assetLabel).toBe('back_cover');
      expect(failure.provider).toBe('openai');
      expect(failure.model).toBe('gpt-image-1');
      expect(failure.message).toContain('back_cover request failed again');
      expect(failure.characterReferenceSupplied).toBe(true);
      expect(failure.requestMode).toBe('character-reference-edit');
      expect(failure.attempts).toBe(1);
      expect(failure.limiterRetries).toBe(0);
      expect(failure.limiterWaitMs).toBe(0);
      // A plain Error carries no HTTP status/type/code — only an OpenAI
      // request failure (see openai-image-generation-provider.spec.ts) does.
      expect(failure.httpStatus).toBeUndefined();
      expect(failure.errorType).toBeUndefined();
      expect(failure.errorCode).toBeUndefined();
      // Timeout-specific diagnostics (see openai-image-generation-provider.ts)
      // are only present when the underlying error actually was a timeout.
      expect(failure.timeoutMs).toBeUndefined();
      expect(failure.elapsedMs).toBeUndefined();
      expect(failure.retryDecision).toBeUndefined();
      warnSpy.mockRestore();
    });
  });
});
