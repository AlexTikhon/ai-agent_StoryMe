import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { BookStatus, GenerationJobType, Prisma, type Book } from '@prisma/client';
import {
  DEFAULT_BOOK_PAGE_COUNT,
  SupportedLanguage,
  type BookDto,
  type BooksPageDto,
  type GenerateBookResponse,
  type GenerationDiagnosticsDto,
} from '@book/types';
import { PrismaService } from '../database/prisma.service';
import { AgentService } from '../agent/agent.service';
import { GenerationTaskRunner } from '../agent/generation-task-runner';
import { GenerationJobService } from '../agent/generation-job.service';
import { PDF_STORAGE_TOKEN, type PdfStorage } from '../pdf/pdf-storage';
import { toBookDto } from './books.mapper';
import { buildGenerationDiagnostics } from './generation-diagnostics';
import type { CreateBookDto } from './dto/create-book.dto';
import type { UpdateBookDto } from './dto/update-book.dto';

/** Book.status value written the moment generation is scheduled — the first pipeline step, non-terminal. */
const GENERATION_STARTED_STATUS = BookStatus.char_build;

/**
 * Statuses where the generation pipeline is not actively running — safe for
 * update()/remove() to mutate. Mirrors TERMINAL_BOOK_STATUSES in
 * generation-job-recovery.service.ts, plus the pre-generation `created` draft
 * state (which is terminal in the sense that nothing is running, even though
 * it isn't a pipeline outcome).
 */
const EDITABLE_BOOK_STATUSES = new Set<BookStatus>([
  BookStatus.created,
  BookStatus.complete,
  BookStatus.failed,
  BookStatus.partial,
  BookStatus.cancelled,
]);

@Injectable()
export class BooksService {
  private readonly logger = new Logger(BooksService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly agentService: AgentService,
    @Inject(PDF_STORAGE_TOKEN) private readonly pdfStorage: PdfStorage,
    private readonly generationTaskRunner: GenerationTaskRunner,
    private readonly generationJobService: GenerationJobService,
  ) {}

  /**
   * Persists a new draft book from a validated CreateBookDto. CreateBookDto's
   * @Transform decorators already trim string fields, so normalization here
   * is limited to defaults for fields the DTO leaves optional: language
   * (SupportedLanguage.English) and pageCount (DEFAULT_BOOK_PAGE_COUNT).
   * Downstream generation (AgentService) and retry both read these
   * already-normalized values back off the Book row — there is no separate
   * "raw request" input to reconcile.
   */
  async create(userId: string, dto: CreateBookDto): Promise<BookDto> {
    const book = await this.prisma.book.create({
      data: {
        userId,
        title: dto.title,
        childName: dto.childName,
        childAge: dto.childAge,
        language: dto.language ?? SupportedLanguage.English,
        theme: dto.theme,
        educationalMessage: dto.educationalMessage ?? null,
        pageCount: dto.pageCount ?? DEFAULT_BOOK_PAGE_COUNT,
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
    if (!EDITABLE_BOOK_STATUSES.has(book.status)) {
      throw new ConflictException('Book cannot be edited while generation is in progress');
    }
    const updated = await this.prisma.book.update({
      where: { id },
      data: dto,
    });
    return toBookDto(updated);
  }

  async remove(id: string, userId: string): Promise<void> {
    const book = await this.findOwnedOrThrow(id, userId);
    if (!EDITABLE_BOOK_STATUSES.has(book.status)) {
      throw new ConflictException('Book cannot be deleted while generation is in progress');
    }
    await this.prisma.book.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
  }

  /**
   * Re-runs book generation in place: clears the failure markers, flips
   * status back to a non-terminal generating state, and schedules the same
   * pipeline used by startGeneration to run in the background. Used both to
   * retry a failed book and to regenerate a complete one (replacing its
   * story/images/PDF with a fresh run against the book's current source
   * fields). AgentService appends new AgentLog rows rather than deleting
   * prior ones, so history stays visible in generation diagnostics.
   */
  async retryGeneration(userId: string, bookId: string): Promise<GenerateBookResponse> {
    const book = await this.findOwnedOrThrow(bookId, userId);
    if (book.status !== BookStatus.failed && book.status !== BookStatus.complete) {
      throw new ConflictException('Only failed or complete books can be regenerated');
    }
    if (this.generationTaskRunner.isRunning(bookId)) {
      throw new ConflictException('Generation is already in progress for this book');
    }
    if (await this.generationJobService.findActive(bookId)) {
      throw new ConflictException('Generation is already in progress for this book');
    }

    // The pre-checks above are best-effort — two concurrent regenerate calls
    // can both pass them before either writes. `claimStatusTransition`'s
    // conditional UPDATE (`where: { id, status: book.status }`) is the actual
    // guard: only one concurrent caller's UPDATE can match the still-current
    // row, so only one GenerationJob/pipeline ever gets scheduled per call.
    const cleared = await this.claimStatusTransition(
      bookId,
      book.status,
      {
        status: GENERATION_STARTED_STATUS,
        failedStep: null,
        errorMessage: null,
        retryCount: { increment: 1 },
      },
      'Only failed or complete books can be regenerated',
    );

    const job = await this.generationJobService.createQueued({
      bookId,
      userId,
      type: GenerationJobType.retry,
      // cleared.retryCount is already post-increment — attempt counts the
      // original generate (1) plus every retry so far.
      attempt: cleared.retryCount + 1,
    });

    await this.scheduleOrThrow(cleared, job.id);

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
    if (await this.generationJobService.findActive(bookId)) {
      throw new ConflictException('Generation is already in progress for this book');
    }

    // See the comment in retryGeneration — this conditional UPDATE is the
    // real duplicate-generation guard; the checks above are just a nicer
    // error message for the common (non-racing) case.
    const started = await this.claimStatusTransition(
      bookId,
      BookStatus.created,
      { status: GENERATION_STARTED_STATUS },
      'Generation already started or completed for this book',
    );

    const job = await this.generationJobService.createQueued({
      bookId,
      userId,
      type: GenerationJobType.generate,
      attempt: 1,
    });

    await this.scheduleOrThrow(started, job.id);

    return { book: toBookDto(started) };
  }

  /**
   * Atomically transitions `bookId` from `fromStatus` to `data`, using the
   * UPDATE's own WHERE clause (rather than a separate read-then-write) as the
   * concurrency guard: Postgres serializes concurrent UPDATEs on the same
   * row, so only the first of two racing callers can match `status:
   * fromStatus` — the loser's UPDATE affects zero rows, which Prisma surfaces
   * as a P2025 "record not found" error, translated here into the same
   * ConflictException the pre-check above would have thrown had it won the race.
   */
  private async claimStatusTransition(
    bookId: string,
    fromStatus: BookStatus,
    data: Prisma.BookUpdateInput,
    conflictMessage: string,
  ): Promise<Book> {
    try {
      return await this.prisma.book.update({
        where: { id: bookId, status: fromStatus },
        data,
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025') {
        throw new ConflictException(conflictMessage);
      }
      throw err;
    }
  }

  /**
   * Schedules the pipeline via GenerationTaskRunner and handles a `false`
   * return explicitly. This should be unreachable in practice — the caller
   * just won the atomic status claim above, so no other request can also be
   * mid-schedule for this book — but the runner's in-memory `running` set is
   * a separate source of truth, so a mismatch is a real (if unlikely) bug
   * surface, not a case to ignore. Rather than leave the book/job stuck in a
   * non-terminal, un-runnable state forever, this marks both failed and
   * surfaces a ConflictException to the caller.
   */
  private async scheduleOrThrow(book: Book, jobId: string): Promise<void> {
    const scheduled = this.generationTaskRunner.run(book.id, () =>
      this.runGenerationPipeline(book, jobId),
    );
    if (scheduled) return;

    this.logger.error(
      `GenerationTaskRunner rejected book ${book.id} immediately after an atomic status claim — marking the job failed instead of leaving it queued forever.`,
    );
    await this.markJob(
      this.generationJobService.markFailed(jobId, {
        errorMessage: 'Generation runner rejected this job (already running)',
      }),
      jobId,
      book.id,
      'failed',
    );
    await this.prisma.book
      .update({
        where: { id: book.id },
        data: {
          status: BookStatus.failed,
          errorMessage: 'Could not start generation — please try again',
        },
      })
      .catch((updateErr: unknown) => {
        const message = updateErr instanceof Error ? updateErr.message : String(updateErr);
        this.logger.error(
          `Failed to mark book ${book.id} failed after a rejected schedule: ${message}`,
        );
      });
    throw new ConflictException('Generation is already in progress for this book');
  }

  /**
   * Runs AgentService's pipeline in the background and never throws — it's
   * invoked from GenerationTaskRunner, outside any HTTP request. AgentService
   * already marks the book failed for every failure it anticipates (story
   * generation, image generation, PDF render); this catch only guards against
   * a truly unexpected error escaping that handling, so the book never gets
   * stuck in a non-terminal status forever. `jobId` is the GenerationJob
   * (Phase 3I) created by startGeneration/retryGeneration — its lifecycle
   * mirrors the book's, but a failure updating it never blocks the pipeline
   * or the book's own status, since Book.status is the source of truth.
   */
  private async runGenerationPipeline(book: Book, jobId: string): Promise<void> {
    await this.markJob(this.generationJobService.markRunning(jobId), jobId, book.id, 'running');
    try {
      const result = await this.agentService.startBookGeneration(book);
      if (result.status === BookStatus.failed) {
        await this.markJob(
          this.generationJobService.markFailed(jobId, {
            errorMessage: result.errorMessage ?? 'Generation failed',
            failedStep: result.failedStep,
          }),
          jobId,
          book.id,
          'failed',
        );
      } else {
        await this.markJob(
          this.generationJobService.markCompleted(jobId),
          jobId,
          book.id,
          'completed',
        );
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `Background generation pipeline threw unexpectedly for book ${book.id}: ${message}`,
      );
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
      await this.markJob(
        this.generationJobService.markFailed(jobId, { errorMessage: message }),
        jobId,
        book.id,
        'failed',
      );
    }
  }

  /** Swallows and logs a GenerationJob status-update failure — it must never affect the pipeline's own outcome. */
  private async markJob(
    update: Promise<unknown>,
    jobId: string,
    bookId: string,
    action: string,
  ): Promise<void> {
    await update.catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `Failed to mark generation job ${jobId} ${action} for book ${bookId}: ${message}`,
      );
    });
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
    const [logs, latestJob] = await Promise.all([
      this.prisma.agentLog.findMany({
        where: { bookId },
        orderBy: { createdAt: 'desc' },
        take: 20,
      }),
      this.generationJobService.findLatest(bookId),
    ]);
    return buildGenerationDiagnostics(book, logs, latestJob);
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
