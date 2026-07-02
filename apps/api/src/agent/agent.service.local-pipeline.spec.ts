import { describe, it, expect, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Book } from '@prisma/client';
import { AgentService } from './agent.service';
import { createMockPrisma } from '../common/test-utils/mock-prisma';
import { LocalImageAssetStorage } from '../images/image-asset-storage';
import type { PdfStorage } from '../pdf/pdf-storage';

// This file deliberately does NOT mock '../pdf/pdf-renderer' or
// '../images/image-asset-storage' — it drives AgentService.startBookGeneration
// through the real mock-image-producer -> ImageAssetStorage -> renderer chain
// (see agent.service.spec.ts for the mocked-renderer unit tests of the rest of
// the pipeline) to prove the full local path actually embeds real image bytes
// in the rendered PDF, not just that each boundary is individually correct.

const TEST_BOOK_ID = 'test-agent-local-pipeline-001';
const TEST_IMAGES_DIR = resolve(process.cwd(), 'tmp', 'images', TEST_BOOK_ID);

function makeBook(overrides: Partial<Book> = {}): Book {
  return {
    id: TEST_BOOK_ID,
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

describe('AgentService local pipeline (real image storage + real PDF renderer)', () => {
  afterEach(async () => {
    if (existsSync(TEST_IMAGES_DIR)) {
      await rm(TEST_IMAGES_DIR, { recursive: true });
    }
  });

  it('renders a PDF with real embedded image bytes end-to-end and saves it to previewPdfUrl', async () => {
    const prisma = createMockPrisma();
    const layoutBook = makeBook({ status: 'layout' as Book['status'] });
    const completedBook = makeBook({
      status: 'complete' as Book['status'],
      previewPdfUrl: `/files/books/${TEST_BOOK_ID}/storybook.pdf`,
    });
    prisma.book.update.mockResolvedValueOnce(layoutBook).mockResolvedValueOnce(completedBook);
    prisma.agentLog.createMany.mockResolvedValue({ count: 9 });

    let savedBuffer: Buffer | undefined;
    const pdfStorage: Pick<PdfStorage, 'savePreviewPdf'> = {
      savePreviewPdf: async (bookId: string, buffer: Buffer) => {
        savedBuffer = buffer;
        return { url: `/files/books/${bookId}/storybook.pdf` };
      },
    };

    const service = new AgentService(
      prisma as never,
      pdfStorage as PdfStorage,
      new LocalImageAssetStorage(),
    );

    const book = makeBook();
    const result = await service.startBookGeneration(book);

    expect(result.status).toBe('complete');
    expect(result.previewPdfUrl).toBe(`/files/books/${TEST_BOOK_ID}/storybook.pdf`);

    expect(savedBuffer).toBeDefined();
    const buf = savedBuffer!;
    // Non-trivial, valid PDF — not a stub.
    expect(buf.slice(0, 5).toString('ascii')).toBe('%PDF-');
    expect(buf.length).toBeGreaterThan(5_000);

    // Real evidence of embedded image objects (not just placeholder rectangles).
    const raw = buf.toString('latin1');
    expect(raw).toContain('/Subtype /Image');
  });
});
