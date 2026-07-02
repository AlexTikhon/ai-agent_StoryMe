import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { BookStatus, type Book } from '@prisma/client';
import type {
  BookDto,
  BooksPageDto,
  GenerateBookResponse,
  GenerationDiagnosticsDto,
} from '@book/types';
import { PrismaService } from '../database/prisma.service';
import { AgentService } from '../agent/agent.service';
import { GenerationTaskRunner } from '../agent/generation-task-runner';
import { PDF_STORAGE_TOKEN, type PdfStorage } from '../pdf/pdf-storage';
import { toBookDto } from './books.mapper';
import { buildGenerationDiagnostics } from './generation-diagnostics';
import type { CreateBookDto } from './dto/create-book.dto';
import type { UpdateBookDto } from './dto/update-book.dto';

/** Book.status value written the moment generation is scheduled — the first pipeline step, non-terminal. */
const GENERATION_STARTED_STATUS = BookStatus.char_build;

@Injectable()
export class BooksService {
  private readonly logger = new Logger(BooksService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly agentService: AgentService,
    @Inject(PDF_STORAGE_TOKEN) private readonly pdfStorage: PdfStorage,
    private readonly generationTaskRunner: GenerationTaskRunner,
  ) {}

  async create(userId: string, dto: CreateBookDto): Promise<BookDto> {
    const book = await this.prisma.book.create({
      data: {
        userId,
        title: dto.title,
        childName: dto.childName,
        childAge: dto.childAge,
        language: dto.language,
        theme: dto.theme,
      },
    });
    return toBookDto(book);
  }

  async findAllForUser(userId: string, page: number, limit: number): Promise<BooksPageDto> {
    const safeLimit = Math.min(Math.max(1, limit), 50);
    const safePage = Math.max(1, page);
    const skip = (safePage - 1) * safeLimit;

    const [total, books] = await Promise.all([
      this.prisma.book.count({ where: { userId, deletedAt: null } }),
      this.prisma.book.findMany({
        where: { userId, deletedAt: null },
        orderBy: { createdAt: 'desc' },
        skip,
        take: safeLimit,
      }),
    ]);

    return { items: books.map(toBookDto), page: safePage, limit: safeLimit, total };
  }

  async findOneForUser(id: string, userId: string): Promise<BookDto> {
    const book = await this.findOwnedOrThrow(id, userId);
    return toBookDto(book);
  }

  async update(id: string, userId: string, dto: UpdateBookDto): Promise<BookDto> {
    const book = await this.findOwnedOrThrow(id, userId);
    if (book.status !== BookStatus.created) {
      throw new ConflictException('Only draft books can be updated');
    }
    const updated = await this.prisma.book.update({
      where: { id },
      data: dto,
    });
    return toBookDto(updated);
  }

  async remove(id: string, userId: string): Promise<void> {
    const book = await this.findOwnedOrThrow(id, userId);
    if (book.status !== BookStatus.created) {
      throw new ConflictException('Only draft books can be deleted');
    }
    await this.prisma.book.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
  }

  /**
   * Retries a failed book generation in place: clears the failure markers,
   * flips status back to a non-terminal generating state, and schedules the
   * same pipeline used by startGeneration to run in the background.
   * AgentService appends new AgentLog rows rather than deleting prior ones,
   * so retry history stays visible in generation diagnostics.
   */
  async retryGeneration(userId: string, bookId: string): Promise<GenerateBookResponse> {
    const book = await this.findOwnedOrThrow(bookId, userId);
    if (book.status !== BookStatus.failed) {
      throw new ConflictException('Only failed books can be retried');
    }
    if (this.generationTaskRunner.isRunning(bookId)) {
      throw new ConflictException('Generation is already in progress for this book');
    }

    const cleared = await this.prisma.book.update({
      where: { id: bookId },
      data: {
        status: GENERATION_STARTED_STATUS,
        failedStep: null,
        errorMessage: null,
        retryCount: { increment: 1 },
      },
    });

    this.generationTaskRunner.run(bookId, () => this.runGenerationPipeline(cleared));

    return { book: toBookDto(cleared) };
  }

  /**
   * Validates and transitions a draft to a non-terminal generating state,
   * then schedules AgentService's pipeline to run in the background — the
   * HTTP response returns as soon as the status transition is persisted,
   * not once generation finishes. See GenerationTaskRunner.
   */
  async startGeneration(userId: string, bookId: string): Promise<GenerateBookResponse> {
    const book = await this.findOwnedOrThrow(bookId, userId);

    const missing: string[] = [];
    if (!book.childName) missing.push('childName');
    if (book.childAge == null) missing.push('childAge');
    if (!book.language) missing.push('language');
    if (!book.theme) missing.push('theme');
    if (missing.length > 0) {
      throw new BadRequestException(`Missing required draft fields: ${missing.join(', ')}`);
    }

    if (book.status !== BookStatus.created) {
      throw new ConflictException('Generation already started or completed for this book');
    }
    if (this.generationTaskRunner.isRunning(bookId)) {
      throw new ConflictException('Generation is already in progress for this book');
    }

    const started = await this.prisma.book.update({
      where: { id: bookId },
      data: { status: GENERATION_STARTED_STATUS },
    });

    this.generationTaskRunner.run(bookId, () => this.runGenerationPipeline(started));

    return { book: toBookDto(started) };
  }

  /**
   * Runs AgentService's pipeline in the background and never throws — it's
   * invoked from GenerationTaskRunner, outside any HTTP request. AgentService
   * already marks the book failed for every failure it anticipates (story
   * generation, image generation, PDF render); this catch only guards against
   * a truly unexpected error escaping that handling, so the book never gets
   * stuck in a non-terminal status forever.
   */
  private async runGenerationPipeline(book: Book): Promise<void> {
    try {
      await this.agentService.startBookGeneration(book);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`Background generation pipeline threw unexpectedly for book ${book.id}: ${message}`);
      await this.prisma.book
        .update({
          where: { id: book.id },
          data: { status: BookStatus.failed, errorMessage: message },
        })
        .catch((updateErr: unknown) => {
          const updateMessage = updateErr instanceof Error ? updateErr.message : String(updateErr);
          this.logger.error(
            `Failed to mark book ${book.id} failed after an unexpected pipeline error: ${updateMessage}`,
          );
        });
    }
  }

  async getPreviewPdfBuffer(
    bookId: string,
    userId: string,
  ): Promise<{ buffer: Buffer; contentType: 'application/pdf'; filename: string }> {
    const book = await this.findOwnedOrThrow(bookId, userId);
    if (!book.previewPdfUrl) {
      throw new ConflictException('PDF not ready — book generation is not complete');
    }
    const result = await this.pdfStorage.getPreviewPdf(bookId);
    if (!result) {
      throw new NotFoundException('PDF file not found in storage');
    }
    return result;
  }

  /** Safe, non-secret generation diagnostics for a book — see generation-diagnostics.ts. */
  async getGenerationDiagnostics(
    bookId: string,
    userId: string,
  ): Promise<GenerationDiagnosticsDto> {
    const book = await this.findOwnedOrThrow(bookId, userId);
    const logs = await this.prisma.agentLog.findMany({
      where: { bookId },
      orderBy: { createdAt: 'desc' },
      take: 20,
    });
    return buildGenerationDiagnostics(book, logs);
  }

  /** Looks up a book and verifies ownership in one query — 404s rather than leaking existence of another user's book. */
  private async findOwnedOrThrow(id: string, userId: string): Promise<Book> {
    const book = await this.prisma.book.findFirst({
      where: { id, userId, deletedAt: null },
    });
    if (!book) {
      throw new NotFoundException('Book not found');
    }
    return book;
  }
}
