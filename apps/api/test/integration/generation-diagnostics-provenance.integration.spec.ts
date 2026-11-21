import { randomUUID } from 'node:crypto';
import { NotFoundException } from '@nestjs/common';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Book, GenerationRun, Prisma } from '@prisma/client';
import type { GenerationDiagnosticsDto } from '@book/types';
import { PrismaService } from '../../src/database/prisma.service';
import { GenerationExecutionService } from '../../src/agent/generation-execution.service';
import { GenerationRunService } from '../../src/agent/generation-run.service';
import { GenerationRunCoordinator } from '../../src/agent/generation-run-coordinator.service';
import type { GenerationQueueService } from '../../src/agent/generation-queue.service';
import { CreditsService } from '../../src/credits/credits.service';
import { buildInputSnapshot, hashInputSnapshot } from '../../src/agent/generation-input-snapshot';
import { createTestAgentService } from '../../src/common/test-utils/create-test-agent-service';
import { MockStoryGenerationProvider } from '../../src/agent/story-generation-provider';
import { MockCharacterProfileProvider } from '../../src/agent/character-profile-provider';
import { MockImageGenerationProvider } from '../../src/images/image-generation-provider';
import { LocalImageAssetStorage } from '../../src/images/image-asset-storage';
import { LocalPdfStorage, type PdfStorage } from '../../src/pdf/pdf-storage';
import { BookArtifactWriteCoordinator } from '../../src/storage/book-artifact-write-coordinator';
import { BookCrudService } from '../../src/books/book-crud.service';
import { BookDiagnosticsService } from '../../src/books/book-diagnostics.service';
import { BookPageChangeService } from '../../src/books/book-page-change.service';
import { buildRunProviderUsage } from '../../src/books/generation-diagnostics';

/**
 * Diagnostics provenance against real PostgreSQL, real local artifact storage,
 * and the real mock-provider pipeline: a published edition and the latest
 * full-book attempt are read from one snapshot and never borrow each other's
 * identity, timestamps or provider usage.
 */
describe('generation diagnostics provenance (real PostgreSQL, local storage, mock providers)', () => {
  const db = new PrismaService();
  const execution = new GenerationExecutionService(db);
  const coordinator = new GenerationRunCoordinator(db, new CreditsService(db));
  const images = new LocalImageAssetStorage();
  const localPdfs = new LocalPdfStorage();
  let failPdf = false;
  // Only the PDF save of a regeneration is failed; every read stays real.
  const pdfs = new Proxy(localPdfs, {
    get(target, prop) {
      if (prop === 'saveClaimPreviewPdf' && failPdf) {
        return async () => {
          throw new Error('synthetic storage failure');
        };
      }
      const value = Reflect.get(target, prop, target) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as PdfStorage;
  const queue = {
    getQueueDiagnostics: async () => ({
      queueName: 'book-generation',
      workerCount: 1,
      counts: { waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0 },
    }),
  } as unknown as GenerationQueueService;
  const agent = createTestAgentService(
    db,
    pdfs,
    images,
    new MockStoryGenerationProvider(),
    new MockImageGenerationProvider(),
    new MockCharacterProfileProvider(),
    execution,
  );
  const users: string[] = [];
  const books: string[] = [];

  beforeAll(() => db.$connect());
  afterAll(() => db.$disconnect());
  afterEach(async () => {
    failPdf = false;
    // Only artifacts and rows this test created.
    for (const bookId of books.splice(0)) {
      await images.deleteBookArtifacts(bookId);
      await localPdfs.deleteBookArtifacts(bookId);
    }
    await db.user.deleteMany({ where: { id: { in: users.splice(0) } } });
  });

  function diagnosticsService(client: PrismaService = db) {
    return new BookDiagnosticsService(
      new BookCrudService(client),
      client,
      new GenerationRunService(client),
      queue,
      pdfs,
    );
  }

  async function user() {
    const created = await db.user.create({
      data: { email: `${randomUUID()}@diagnostics-provenance.test` },
    });
    users.push(created.id);
    return created;
  }

  async function book(userId: string) {
    const created = await db.book.create({
      data: {
        userId,
        childName: 'Mia',
        childAge: 6,
        language: 'en',
        theme: 'friendship',
        pageCount: 4,
      },
    });
    books.push(created.id);
    return created;
  }

  async function claim(value: Book, kind: 'initial' | 'regenerate' | 'retry' = 'regenerate') {
    const inputSnapshot = buildInputSnapshot(value);
    const run = await db.generationRun.create({
      data: {
        bookId: value.id,
        userId: value.userId,
        kind,
        inputSnapshot: inputSnapshot as unknown as Prisma.InputJsonValue,
        inputHash: hashInputSnapshot(inputSnapshot),
      },
    });
    await db.book.update({
      where: { id: value.id },
      data: { activeRunId: run.id, status: 'char_build' },
    });
    const delivery = await new GenerationRunService(db).claim(run.id, randomUUID(), 'test', 60_000);
    return {
      runId: run.id,
      bookId: value.id,
      fencingVersion: delivery!.fencingVersion,
      inputSnapshot,
      inputHash: run.inputHash,
    };
  }

  async function generate(value: Book, kind?: 'initial' | 'regenerate' | 'retry') {
    const ctx = await claim(value, kind);
    const outcome = await agent.startBookGeneration(ctx);
    return { ctx, outcome };
  }

  async function publish(value: Book) {
    const { ctx, outcome } = await generate(value, 'initial');
    expect(outcome.status).toBe('complete');
    expect(await coordinator.completeRun(ctx, outcome)).toBe('applied');
    return ctx;
  }

  const run = (id: string) => db.generationRun.findUniqueOrThrow({ where: { id } });
  const reload = (id: string) => db.book.findUniqueOrThrow({ where: { id } });
  const iso = (value: Date | null) => (value ? value.toISOString() : null);

  function expectRunTimestamps(actual: unknown, row: GenerationRun) {
    expect((actual as { timestamps?: unknown }).timestamps).toEqual({
      createdAt: row.createdAt.toISOString(),
      startedAt: iso(row.startedAt),
      completedAt: iso(row.completedAt),
      failedAt: iso(row.failedAt),
      cancelledAt: iso(row.cancelledAt),
    });
  }

  function published(diagnostics: GenerationDiagnosticsDto) {
    expect(diagnostics.publishedEdition).not.toBeNull();
    return diagnostics.publishedEdition!;
  }

  it('separates edition A, its text revision, failed B, cancelled queued D and published C', async () => {
    const owner = await user();
    const initial = await book(owner.id);
    const diagnostics = diagnosticsService();
    const read = () => diagnostics.getGenerationDiagnostics(initial.id, owner.id);

    // ── A completes and publishes.
    const a = await publish(initial);
    const runA = await run(a.runId);
    const afterA = await read();
    const editionA = published(afterA);
    expect(editionA.sourceGenerationRun).toMatchObject({
      availability: 'recorded',
      runId: a.runId,
      fencingVersion: a.fencingVersion,
      status: 'completed',
    });
    expectRunTimestamps(editionA.sourceGenerationRun, runA);
    expect(editionA.revisedAfterGeneration).toBe(false);
    expect(editionA.baseGenerationUsage).toEqual(buildRunProviderUsage(runA));
    expect(editionA.baseGenerationUsage.availability).toBe('recorded');
    expect(afterA.latestAttempt).toMatchObject({ runId: a.runId, isPublishedSource: true });
    expect(afterA.pdfStorage).toMatchObject({ keyPresent: true, previewAvailable: true });

    // ── A text correction changes the edition without creating a run.
    const page = await db.bookPage.findUniqueOrThrow({
      where: { bookId_pageNumber: { bookId: initial.id, pageNumber: 1 } },
    });
    const pageChange = new BookPageChangeService(
      new BookCrudService(db),
      db,
      pdfs,
      images,
      new BookArtifactWriteCoordinator(db, images, pdfs),
    );
    await pageChange.updatePageText(owner.id, initial.id, 1, {
      text: 'A corrected first page.',
      expectedVersion: page.version,
    });
    const afterRevision = await read();
    const revised = published(afterRevision);
    expect(revised.edition).not.toBe(editionA.edition);
    expect(revised.revisedAfterGeneration).toBe(true);
    expect(revised.sourceGenerationRun).toEqual(editionA.sourceGenerationRun);
    expect(revised.baseGenerationUsage).toEqual(editionA.baseGenerationUsage);
    expect(afterRevision.latestAttempt).toEqual(afterA.latestAttempt);
    expect(await db.generationRun.count({ where: { bookId: initial.id } })).toBe(1);
    expect(await run(a.runId)).toEqual(runA);
    expect(afterRevision.pdfStorage).toMatchObject({ keyPresent: true, previewAvailable: true });

    // ── B regenerates changed input and fails to save its PDF.
    const edited = await db.book.update({ where: { id: initial.id }, data: { theme: 'space' } });
    failPdf = true;
    const b = await generate(edited);
    expect(b.outcome.status).toBe('failed');
    await coordinator.completeRun(b.ctx, b.outcome);
    failPdf = false;
    const runB = await run(b.ctx.runId);
    const afterB = await read();
    expect(afterB.status).toBe('failed');
    // A (as revised) stays published with A's provenance.
    expect(published(afterB)).toEqual(revised);
    const attemptB = afterB.latestAttempt!;
    expect(attemptB).toMatchObject({
      runId: b.ctx.runId,
      kind: 'regenerate',
      status: 'failed',
      isPublishedSource: false,
      error: { message: runB.errorMessage, failedStep: runB.currentStep },
    });
    expect(attemptB.error?.message).toBeTruthy();
    expectRunTimestamps(attemptB, runB);
    expect(attemptB.runWallClockDurationMs).toBe(
      runB.failedAt!.getTime() - runB.startedAt!.getTime(),
    );
    expect(attemptB.providerUsage).toEqual(buildRunProviderUsage(runB));
    expect(attemptB.providerUsage.availability).toBe('recorded');
    expect(await run(a.runId)).toEqual(runA);

    // ── D is cancelled while still queued: it has no ledger, and nothing
    // falls back to A's usage.
    const current = await reload(initial.id);
    const snapshot = buildInputSnapshot(current);
    const queuedD = await db.generationRun.create({
      data: {
        bookId: current.id,
        userId: owner.id,
        kind: 'regenerate',
        inputSnapshot: snapshot as unknown as Prisma.InputJsonValue,
        inputHash: hashInputSnapshot(snapshot),
      },
    });
    await db.book.update({
      where: { id: current.id },
      data: { activeRunId: queuedD.id, status: 'char_build' },
    });
    expect(
      await coordinator.cancelGeneration({ bookId: current.id, userId: owner.id }),
    ).toMatchObject({ kind: 'applied', runId: queuedD.id });
    const runD = await run(queuedD.id);
    const afterD = await read();
    expect(afterD.latestAttempt).toMatchObject({
      runId: queuedD.id,
      status: 'cancelled',
      runWallClockDurationMs: null,
      providerUsage: { availability: 'unavailable', reason: 'never_claimed' },
    });
    expectRunTimestamps(afterD.latestAttempt!, runD);
    expect(afterD.latestAttempt!.timestamps.startedAt).toBeNull();
    expect(published(afterD)).toEqual(revised);

    // ── C succeeds: publication provenance advances to C.
    const c = await generate(await reload(initial.id), 'retry');
    expect(c.outcome.status).toBe('complete');
    expect(await coordinator.completeRun(c.ctx, c.outcome)).toBe('applied');
    const runC = await run(c.ctx.runId);
    const afterC = await read();
    const editionC = published(afterC);
    expect(editionC.edition).toBe(`${c.ctx.runId}:${c.ctx.fencingVersion}`);
    expect(editionC.revisedAfterGeneration).toBe(false);
    expect(editionC.sourceGenerationRun).toMatchObject({ runId: c.ctx.runId, kind: 'retry' });
    expectRunTimestamps(editionC.sourceGenerationRun, runC);
    expect(editionC.baseGenerationUsage).toEqual(buildRunProviderUsage(runC));
    expect(afterC.latestAttempt).toMatchObject({ runId: c.ctx.runId, isPublishedSource: true });
    expect(afterC.latestAttempt!.providerUsage).toEqual(editionC.baseGenerationUsage);
    // Earlier history is untouched by every later step.
    expect(await run(a.runId)).toEqual(runA);
    expect(await run(b.ctx.runId)).toEqual(runB);
  }, 120_000);

  it('reads one coherent snapshot when a publication commits mid-read', async () => {
    const owner = await user();
    const initial = await book(owner.id);
    const a = await publish(initial);
    const edited = await db.book.update({ where: { id: initial.id }, data: { theme: 'ocean' } });
    const c = await generate(edited);
    expect(c.outcome.status).toBe('complete');

    // C's publication commits on another connection right after the book row
    // is read inside the diagnostics snapshot.
    let publicationCommitted = false;
    const interleaved = new Proxy(db, {
      get(target, prop) {
        if (prop !== '$transaction') {
          const value = Reflect.get(target, prop, target) as unknown;
          return typeof value === 'function' ? value.bind(target) : value;
        }
        return (
          callback: (tx: Prisma.TransactionClient) => Promise<unknown>,
          options?: Parameters<PrismaService['$transaction']>[1],
        ) =>
          target.$transaction(async (tx) => {
            const book = {
              findFirst: async (args: Prisma.BookFindFirstArgs) => {
                const row = await tx.book.findFirst(args);
                if (!publicationCommitted) {
                  publicationCommitted = true;
                  expect(await coordinator.completeRun(c.ctx, c.outcome)).toBe('applied');
                }
                return row;
              },
            };
            return callback(
              new Proxy(tx, {
                get: (t, p) => (p === 'book' ? book : Reflect.get(t, p, t)),
              }),
            );
          }, options);
      },
    }) as PrismaService;

    const during = await diagnosticsService(interleaved).getGenerationDiagnostics(
      initial.id,
      owner.id,
    );
    expect(publicationCommitted).toBe(true);
    // Everything describes the pre-publication snapshot: A published, C running.
    expect(during.publishedEdition?.sourceGenerationRun).toMatchObject({ runId: a.runId });
    expect(during.publishedEdition?.baseGenerationUsage).toEqual(
      buildRunProviderUsage(await run(a.runId)),
    );
    expect(during.latestAttempt).toMatchObject({
      runId: c.ctx.runId,
      status: 'running',
      isPublishedSource: false,
      timestamps: { completedAt: null },
    });
    expect(during.status).not.toBe('complete');

    const after = await diagnosticsService().getGenerationDiagnostics(initial.id, owner.id);
    expect(after.publishedEdition?.sourceGenerationRun).toMatchObject({ runId: c.ctx.runId });
    expect(after.latestAttempt).toMatchObject({
      runId: c.ctx.runId,
      status: 'completed',
      isPublishedSource: true,
    });
  }, 120_000);

  it('scopes every lookup to the owner and keeps legacy provenance unavailable', async () => {
    const owner = await user();
    const stranger = await user();
    const value = await book(owner.id);
    const a = await publish(value);
    const service = diagnosticsService();

    await expect(service.getGenerationDiagnostics(value.id, stranger.id)).rejects.toThrow(
      NotFoundException,
    );

    // A newer run row for this book under another user is never attributed.
    const snapshot = buildInputSnapshot(await reload(value.id));
    const foreign = await db.generationRun.create({
      data: {
        bookId: value.id,
        userId: stranger.id,
        kind: 'regenerate',
        status: 'failed',
        inputSnapshot: snapshot as unknown as Prisma.InputJsonValue,
        inputHash: hashInputSnapshot(snapshot),
        providerOperations: [],
        createdAt: new Date(Date.now() + 60_000),
      },
    });
    const owned = await service.getGenerationDiagnostics(value.id, owner.id);
    expect(owned.latestAttempt?.runId).toBe(a.runId);
    expect(JSON.stringify(owned)).not.toContain(foreign.id);

    // A publication pointer naming another owner's run is a missing record.
    await db.book.update({ where: { id: value.id }, data: { publishedRunId: foreign.id } });
    const dangling = await service.getGenerationDiagnostics(value.id, owner.id);
    expect(dangling.publishedEdition).toMatchObject({
      sourceGenerationRun: {
        availability: 'unavailable',
        reason: 'run_record_missing',
        runId: foreign.id,
      },
      baseGenerationUsage: { availability: 'unavailable', reason: 'source_run_unavailable' },
    });

    // A legacy publication with no run pointer and no runs fabricates nothing.
    const legacy = await book(owner.id);
    await db.book.update({
      where: { id: legacy.id },
      data: {
        status: 'complete',
        previewPdfUrl: `/files/books/${legacy.id}/storybook.pdf`,
        generationTimeMs: 4200,
      },
    });
    const legacyDiagnostics = await service.getGenerationDiagnostics(legacy.id, owner.id);
    expect(legacyDiagnostics.latestAttempt).toBeNull();
    expect(legacyDiagnostics.latestJob).toBeNull();
    expect(legacyDiagnostics.publishedEdition).toMatchObject({
      edition: 'legacy',
      sourceGenerationRun: { availability: 'unavailable', reason: 'legacy_publication' },
      baseGenerationUsage: { availability: 'unavailable', reason: 'source_run_unavailable' },
    });
    expect(JSON.stringify(legacyDiagnostics.publishedEdition)).not.toContain('4200');
  }, 120_000);
});
