import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { GenerationDiagnosticsDto, GenerationProgressDto } from '@book/types';
import { Prisma, type GenerationRun } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { GenerationQueueService } from '../agent/generation-queue.service';
import { GenerationRunService } from '../agent/generation-run.service';
import { resolvePublishedPdfNamespace } from '../agent/generation-artifact-namespace';
import { publishedPreviewPdfExists, PDF_STORAGE_TOKEN, type PdfStorage } from '../pdf/pdf-storage';
import { BookCrudService } from './book-crud.service';
import {
  buildGenerationDiagnostics,
  type GenerationDiagnosticsSnapshot,
} from './generation-diagnostics';

/** Bounded book-level log window; diagnostics never scan full history. */
export const DIAGNOSTICS_RECENT_LOG_LIMIT = 20;

/**
 * Read-only diagnostics boundary. Database provenance (owned Book, its newest
 * GenerationRun, the run the publication pointer names, and a bounded recent
 * log window) is read in one REPEATABLE READ snapshot, so a publication that
 * commits mid-read cannot pair one attempt's run with another's edition.
 * Storage and queue state are read-time observations taken afterwards; they
 * are not atomic with PostgreSQL. It never participates in generation
 * transactions.
 */
@Injectable()
export class BookDiagnosticsService {
  constructor(
    private readonly crud: BookCrudService,
    private readonly prisma: PrismaService,
    private readonly generationRunService: GenerationRunService,
    private readonly generationQueueService: GenerationQueueService,
    @Inject(PDF_STORAGE_TOKEN) private readonly pdfStorage: PdfStorage,
  ) {}

  async getGenerationDiagnostics(
    bookId: string,
    userId: string,
  ): Promise<GenerationDiagnosticsDto> {
    const snapshot = await this.readSnapshot(bookId, userId);
    const namespace = resolvePublishedPdfNamespace(snapshot.book);
    const keyPresent = namespace.kind !== 'not_ready';
    const [previewAvailable, queue] = await Promise.all([
      keyPresent
        ? publishedPreviewPdfExists(this.pdfStorage, bookId, namespace)
        : Promise.resolve(false),
      this.generationQueueService.getQueueDiagnostics(),
    ]);

    return buildGenerationDiagnostics(snapshot, {
      pdfStorage: {
        driver: this.pdfStorage.driver,
        keyPresent,
        previewAvailable: keyPresent && previewAvailable,
      },
      queue,
    });
  }

  async getGenerationProgress(bookId: string, userId: string): Promise<GenerationProgressDto> {
    await this.crud.findOwnedOrThrow(bookId, userId);
    return toGenerationProgress(await this.generationRunService.findLatestForBook(bookId));
  }

  /**
   * Every run lookup is scoped to this book and owner. Queries are bounded:
   * at most two GenerationRun rows (newest, and the published source when it
   * differs) and DIAGNOSTICS_RECENT_LOG_LIMIT log rows.
   */
  private readSnapshot(bookId: string, userId: string): Promise<GenerationDiagnosticsSnapshot> {
    return this.prisma.$transaction(
      async (tx) => {
        // Same ownership predicate as BookCrudService.findOwnedOrThrow. It is
        // the first statement, so the snapshot is taken here.
        const book = await tx.book.findFirst({ where: { id: bookId, userId, deletedAt: null } });
        if (!book) throw new NotFoundException('Book not found');

        const latestRun = await tx.generationRun.findFirst({
          where: { bookId, userId },
          orderBy: { createdAt: 'desc' },
        });
        const publishedSourceRun = !book.publishedRunId
          ? null
          : latestRun?.id === book.publishedRunId
            ? latestRun
            : await tx.generationRun.findFirst({
                where: { id: book.publishedRunId, bookId, userId },
              });
        const logs = await tx.agentLog.findMany({
          where: { bookId },
          orderBy: { createdAt: 'desc' },
          take: DIAGNOSTICS_RECENT_LOG_LIMIT,
        });
        return { book, latestRun, publishedSourceRun, logs };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }
}

function toGenerationProgress(run: GenerationRun | null): GenerationProgressDto {
  if (!run) return { status: 'idle', step: null };

  return {
    status: run.status === 'completed' ? 'complete' : run.status,
    step: run.currentStep as GenerationProgressDto['step'],
  };
}
