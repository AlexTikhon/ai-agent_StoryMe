import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { GenerationRunStatus, type Prisma, type Book, type GenerationRun } from '@prisma/client';
import { PrismaService } from '../../src/database/prisma.service';
import { CreditsService } from '../../src/credits/credits.service';
import { GenerationRunCoordinator } from '../../src/agent/generation-run-coordinator.service';
import type { GenerationOutcome } from '../../src/agent/generation-outcome';
import { buildInputSnapshot, hashInputSnapshot } from '../../src/agent/generation-input-snapshot';
import {
  claimNamespace,
  resolvePublishedPdfNamespace,
} from '../../src/agent/generation-artifact-namespace';
import {
  LocalPdfStorage,
  getPublishedPreviewPdf,
  publishedPreviewPdfExists,
} from '../../src/pdf/pdf-storage';

/**
 * Durable integration coverage against a real Postgres + real local-disk
 * PdfStorage (see vitest.integration.config.ts) for Phase B, Slice B4 — the
 * claim-scoped PDF write path and its fenced publication boundary
 * (GenerationRunCoordinator.completeRun). A mocked Prisma/PdfStorage cannot
 * prove the thing this slice actually depends on: that Postgres's real
 * row-fencing and a real filesystem round-trip agree on which claim's bytes
 * are "the" published PDF at any given moment, including while a second,
 * still-in-flight claim has already written its own (unpublished) object
 * alongside it.
 */
describe('PDF publication (Phase B, Slice B4 — real Postgres + local storage)', () => {
  const prisma = new PrismaService();
  const coordinator = new GenerationRunCoordinator(prisma, new CreditsService(prisma));
  const storage = new LocalPdfStorage();
  const userIds: string[] = [];
  const bookIdsForStorageCleanup: string[] = [];

  beforeAll(async () => {
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  afterEach(async () => {
    if (userIds.length > 0) {
      await prisma.user.deleteMany({ where: { id: { in: userIds } } });
      userIds.length = 0;
    }
    for (const bookId of bookIdsForStorageCleanup) {
      const dir = resolve(process.cwd(), 'tmp', 'books', bookId);
      if (existsSync(dir)) await rm(dir, { recursive: true });
    }
    bookIdsForStorageCleanup.length = 0;
  });

  async function createUserAndBook(overrides: Partial<Book> = {}): Promise<Book> {
    const user = await prisma.user.create({
      data: { email: `pdf-publication-${randomUUID()}@example.test` },
    });
    userIds.push(user.id);
    const book = await prisma.book.create({
      data: {
        userId: user.id,
        status: 'char_build',
        childName: 'Mia',
        childAge: 5,
        language: 'en',
        theme: 'friendship',
        pageCount: 6,
        ...overrides,
      },
    });
    bookIdsForStorageCleanup.push(book.id);
    return book;
  }

  async function createRun(
    book: Book,
    overrides: Partial<GenerationRun> = {},
  ): Promise<GenerationRun> {
    const snapshot = buildInputSnapshot(book);
    const run = await prisma.generationRun.create({
      data: {
        bookId: book.id,
        userId: book.userId,
        kind: 'initial',
        status: GenerationRunStatus.running,
        inputSnapshot: snapshot as unknown as Prisma.InputJsonValue,
        inputHash: hashInputSnapshot(snapshot),
        fencingVersion: 1,
        ...(overrides as Prisma.GenerationRunUncheckedCreateInput),
      },
    });
    await prisma.book.update({ where: { id: book.id }, data: { activeRunId: run.id } });
    return run;
  }

  function completedOutcome(overrides: Partial<GenerationOutcome> = {}): GenerationOutcome {
    return {
      status: 'complete' as GenerationOutcome['status'],
      completedStep: 'pdf_render' as GenerationOutcome['completedStep'],
      bookUpdate: {},
      agentLogs: [],
      ...overrides,
    };
  }

  function failedOutcome(overrides: Partial<GenerationOutcome> = {}): GenerationOutcome {
    return {
      status: 'failed' as GenerationOutcome['status'],
      completedStep: 'pdf_render' as GenerationOutcome['completedStep'],
      errorCode: 'GENERATION_FAILED',
      errorMessage: 'boom',
      failedStep: 'pdf_render' as GenerationOutcome['failedStep'],
      bookUpdate: {},
      agentLogs: [],
      ...overrides,
    };
  }

  /** Reads whatever is actually published for `book`, through the exact production resolver + dispatch, never a shortcut around them. */
  async function readPublished(book: Book) {
    const namespace = resolvePublishedPdfNamespace(book);
    return getPublishedPreviewPdf(storage, book.id, namespace);
  }

  async function publishedExists(book: Book): Promise<boolean> {
    const namespace = resolvePublishedPdfNamespace(book);
    return publishedPreviewPdfExists(storage, book.id, namespace);
  }

  it('an older claim (P) stays published and readable while a newer run (B) is active and even after B writes its own claim-scoped PDF but fails before publishing', async () => {
    const book = await createUserAndBook();
    const runP = await createRun(book, { fencingVersion: 1 });
    const bufferP = Buffer.from('%PDF-1.4 claim P bytes');
    await storage.saveClaimPreviewPdf(book.id, claimNamespace(runP.id, 1), bufferP);

    const publishP = await coordinator.completeRun(
      { runId: runP.id, bookId: book.id, fencingVersion: 1 },
      completedOutcome({
        bookUpdate: {
          previewPdfUrl: `/files/books/${book.id}/runs/${runP.id}/claims/1/storyme-preview-${book.id}.pdf`,
        },
      }),
    );
    expect(publishP).toBe('applied');

    let reloadedBook = await prisma.book.findUniqueOrThrow({ where: { id: book.id } });
    expect((await readPublished(reloadedBook))!.buffer.equals(bufferP)).toBe(true);

    // A newer run (B) starts on the same book — activeRunId now points at it,
    // but nothing about that changes what's published yet.
    const runB = await createRun(book, { fencingVersion: 1 });
    reloadedBook = await prisma.book.findUniqueOrThrow({ where: { id: book.id } });
    expect((await readPublished(reloadedBook))!.buffer.equals(bufferP)).toBe(true);

    // B writes its own claim-scoped PDF — a real, separate object — but then
    // fails before ever reaching a successful completion.
    const bufferB = Buffer.from('%PDF-1.4 claim B bytes (never published)');
    await storage.saveClaimPreviewPdf(book.id, claimNamespace(runB.id, 1), bufferB);
    const failB = await coordinator.completeRun(
      { runId: runB.id, bookId: book.id, fencingVersion: 1 },
      failedOutcome(),
    );
    expect(failB).toBe('applied'); // the fenced *failure* transition itself applies

    reloadedBook = await prisma.book.findUniqueOrThrow({ where: { id: book.id } });
    expect(reloadedBook.publishedRunId).toBe(runP.id);
    expect(reloadedBook.publishedRunFencingVersion).toBe(1);
    // P's bytes are still exactly what's served — B's object exists in
    // storage (an unpublished orphan) but is never the one resolved.
    const finalRead = await readPublished(reloadedBook);
    expect(finalRead!.buffer.equals(bufferP)).toBe(true);
    expect(finalRead!.buffer.equals(bufferB)).toBe(false);
  });

  it('same-run redelivery: claim B (fencingVersion 2) wins the fenced terminal transition over claim A (fencingVersion 1); A never gets served even after a late write', async () => {
    const book = await createUserAndBook();
    const run = await createRun(book, { fencingVersion: 1 });

    const namespaceA = claimNamespace(run.id, 1);
    const namespaceB = claimNamespace(run.id, 2);
    const bufferA = Buffer.from('%PDF-1.4 claim A (stale delivery)');
    const bufferB = Buffer.from('%PDF-1.4 claim B (winning delivery)');
    await storage.saveClaimPreviewPdf(book.id, namespaceA, bufferA);
    await storage.saveClaimPreviewPdf(book.id, namespaceB, bufferB);

    // Simulate the stalled-redelivery reclaim bumping fencingVersion in the
    // DB (GenerationRunService.claim's real job) without changing runId.
    await prisma.generationRun.update({ where: { id: run.id }, data: { fencingVersion: 2 } });

    const resultA = await coordinator.completeRun(
      { runId: run.id, bookId: book.id, fencingVersion: 1 },
      completedOutcome({ bookUpdate: { previewPdfUrl: 'from-A' } }),
    );
    expect(resultA).toBe('stale_fence');

    const resultB = await coordinator.completeRun(
      { runId: run.id, bookId: book.id, fencingVersion: 2 },
      completedOutcome({ bookUpdate: { previewPdfUrl: 'from-B' } }),
    );
    expect(resultB).toBe('applied');

    let reloadedBook = await prisma.book.findUniqueOrThrow({ where: { id: book.id } });
    expect(reloadedBook.publishedRunId).toBe(run.id);
    expect(reloadedBook.publishedRunFencingVersion).toBe(2);
    expect((await readPublished(reloadedBook))!.buffer.equals(bufferB)).toBe(true);

    // A's late storage write — the stale worker doesn't know it lost the
    // race and writes anyway — never changes what's served.
    const lateBufferA = Buffer.from('%PDF-1.4 claim A late write');
    await storage.saveClaimPreviewPdf(book.id, namespaceA, lateBufferA);

    reloadedBook = await prisma.book.findUniqueOrThrow({ where: { id: book.id } });
    const finalRead = await readPublished(reloadedBook);
    expect(finalRead!.buffer.equals(bufferB)).toBe(true);
    expect(finalRead!.buffer.equals(lateBufferA)).toBe(false);
    expect(finalRead!.buffer.equals(bufferA)).toBe(false);
  });

  it('genuinely concurrent completeRun calls on the same fencingVersion (fired together, real overlapping transactions) publish exactly one claim', async () => {
    const book = await createUserAndBook();
    const run = await createRun(book, { fencingVersion: 4 });
    const namespace = claimNamespace(run.id, 4);
    const buffer = Buffer.from('%PDF-1.4 the one claim both racers wrote to');
    await storage.saveClaimPreviewPdf(book.id, namespace, buffer);

    const ctx = { runId: run.id, bookId: book.id, fencingVersion: 4 };
    const [resultA, resultB] = await Promise.all([
      coordinator.completeRun(ctx, completedOutcome({ bookUpdate: { title: 'From attempt A' } })),
      coordinator.completeRun(ctx, completedOutcome({ bookUpdate: { title: 'From attempt B' } })),
    ]);

    expect([resultA, resultB].filter((r) => r === 'applied')).toHaveLength(1);
    expect([resultA, resultB].filter((r) => r === 'stale_fence')).toHaveLength(1);

    const reloadedBook = await prisma.book.findUniqueOrThrow({ where: { id: book.id } });
    expect(reloadedBook.publishedRunId).toBe(run.id);
    expect(reloadedBook.publishedRunFencingVersion).toBe(4);
    expect((await readPublished(reloadedBook))!.buffer.equals(buffer)).toBe(true);
  });

  it('a legacy Book (pre-Phase-B: publishedRunId set, no fencing version) remains readable via the legacy PDF key after the B4 migration', async () => {
    const legacyBuffer = Buffer.from('%PDF-1.4 pre-Phase-B legacy publication');
    const book = await createUserAndBook({
      status: 'complete',
      publishedRunId: randomUUID(),
      publishedRunFencingVersion: null,
      previewPdfUrl: `/files/books/placeholder/storybook.pdf`,
    });
    await storage.savePreviewPdf(book.id, legacyBuffer);

    expect((await readPublished(book))!.buffer.equals(legacyBuffer)).toBe(true);
    expect(await publishedExists(book)).toBe(true);
  });

  it('a pre-GenerationRun legacy Book (no published pointer at all, only previewPdfUrl) remains readable via the legacy PDF key', async () => {
    const legacyBuffer = Buffer.from('%PDF-1.4 pre-GenerationRun legacy publication');
    const book = await createUserAndBook({
      status: 'complete',
      previewPdfUrl: `/files/books/placeholder/storybook.pdf`,
    });
    await storage.savePreviewPdf(book.id, legacyBuffer);

    expect((await readPublished(book))!.buffer.equals(legacyBuffer)).toBe(true);
    expect(await publishedExists(book)).toBe(true);
  });
});
