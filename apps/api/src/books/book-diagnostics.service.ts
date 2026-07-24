import { Inject, Injectable } from '@nestjs/common';
import type { GenerationDiagnosticsDto } from '@book/types';
import { PrismaService } from '../database/prisma.service';
import { GenerationQueueService } from '../agent/generation-queue.service';
import { GenerationRunService } from '../agent/generation-run.service';
import { resolvePublishedPdfNamespace } from '../agent/generation-artifact-namespace';
import { publishedPreviewPdfExists, PDF_STORAGE_TOKEN, type PdfStorage } from '../pdf/pdf-storage';
import { BookCrudService } from './book-crud.service';
import { buildGenerationDiagnostics } from './generation-diagnostics';

/**
 * Read-only diagnostics boundary. It composes owned Book state, authoritative
 * GenerationRun state, recent logs, queue health, and published-storage
 * availability without participating in generation transactions.
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
    const book = await this.crud.findOwnedOrThrow(bookId, userId);
    const namespace = resolvePublishedPdfNamespace(book);
    const keyPresent = namespace.kind !== 'not_ready';
    const [logs, latestRun, previewAvailable, queue] = await Promise.all([
      this.prisma.agentLog.findMany({
        where: { bookId },
        orderBy: { createdAt: 'desc' },
        take: 20,
      }),
      this.generationRunService.findLatestForBook(bookId),
      keyPresent
        ? publishedPreviewPdfExists(this.pdfStorage, bookId, namespace)
        : Promise.resolve(false),
      this.generationQueueService.getQueueDiagnostics(),
    ]);

    return buildGenerationDiagnostics(
      book,
      logs,
      latestRun,
      {
        driver: this.pdfStorage.driver,
        keyPresent,
        previewAvailable: keyPresent && previewAvailable,
      },
      queue,
    );
  }
}
