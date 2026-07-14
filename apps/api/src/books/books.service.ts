import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  BookStatus,
  GenerationJobType,
  GenerationRunStatus,
  Prisma,
  type Book,
  type GenerationRun,
  type GenerationRunKind,
} from '@prisma/client';
import {
  DEFAULT_BOOK_PAGE_COUNT,
  SupportedLanguage,
  type BookDto,
  type BooksPageDto,
  type GenerateBookResponse,
  type GenerationDiagnosticsDto,
} from '@book/types';
import type { Env } from '../config/env.schema';
import { PrismaService } from '../database/prisma.service';
import { AgentService } from '../agent/agent.service';
import { GenerationQueueService } from '../agent/generation-queue.service';
import { GenerationJobService } from '../agent/generation-job.service';
import { GenerationRunService } from '../agent/generation-run.service';
import {
  buildInputSnapshot,
  hashInputSnapshot,
  type GenerationInputSnapshot,
} from '../agent/generation-input-snapshot';
import { PDF_STORAGE_TOKEN, type PdfStorage } from '../pdf/pdf-storage';
import { RATE_LIMITER_TOKEN, type RateLimiter } from '../rate-limit/rate-limiter.interface';
import {
  childPhotoAssetKey,
  IMAGE_ASSET_STORAGE_TOKEN,
  type ImageAssetStorage,
} from '../images/image-asset-storage';
import { ChildPhotoProcessor } from '../images/child-photo-processor';
import { toBookDto } from './books.mapper';
import { buildGenerationDiagnostics } from './generation-diagnostics';
import type { CreateBookDto } from './dto/create-book.dto';
import type { UpdateBookDto } from './dto/update-book.dto';

/** Fixed key for the global generation circuit breaker — one shared budget across every user/book, not scoped to any single identity. */
const GLOBAL_GENERATION_CIRCUIT_KEY = 'global-generation-circuit';

/** True for the P2002 unique-violation Postgres raises for the hand-added `generation_runs_one_active_per_book` partial index (see the Phase 2A migration) — Prisma doesn't model this index (no native conditional-unique syntax), but still parses the underlying column out of Postgres's error detail into `meta.target`. */
function isOneActiveRunViolation(err: unknown): boolean {
  return (
    err instanceof Prisma.PrismaClientKnownRequestError &&
    err.code === 'P2002' &&
    err.meta?.['modelName'] === 'GenerationRun'
  );
}

function isRecordNotFound(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025';
}

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
    @Inject(IMAGE_ASSET_STORAGE_TOKEN) private readonly imageAssetStorage: ImageAssetStorage,
    private readonly generationQueueService: GenerationQueueService,
    private readonly generationJobService: GenerationJobService,
    private readonly generationRunService: GenerationRunService,
    private readonly config: ConfigService<Env, true>,
    @Inject(RATE_LIMITER_TOKEN) private readonly rateLimiter: RateLimiter,
    private readonly childPhotoProcessor: ChildPhotoProcessor,
  ) {}

  /**
   * Business-rule guards on starting a (paid) generation run — distinct from
   * the per-book "is one already active" check in startGeneration/
   * retryGeneration and from the raw per-route request throttle
   * (UserRateLimitGuard). Three independent checks, all must pass:
   *   1. a global circuit breaker — total generation starts across every
   *      user, a safety valve against a runaway cost incident;
   *   2. a per-user concurrent-generation cap — how many runs one user may
   *      have in flight at once, across all of their books;
   *   3. a per-user rolling-window cap — how many runs one user may start in
   *      a configurable window.
   * Throws a stable, safe error code for each — never a raw count or
   * provider/cost detail.
   */
  private async assertGenerationAllowed(userId: string): Promise<void> {
    const circuitWindowMs = this.config.get('GLOBAL_GENERATION_CIRCUIT_WINDOW_MS', {
      infer: true,
    });
    const circuitMax = this.config.get('GLOBAL_GENERATION_CIRCUIT_MAX_PER_WINDOW', {
      infer: true,
    });
    const circuit = await this.rateLimiter.consume(
      GLOBAL_GENERATION_CIRCUIT_KEY,
      circuitWindowMs,
      circuitMax,
    );
    if (!circuit.allowed) {
      throw new ServiceUnavailableException({
        error: 'Generation capacity temporarily exceeded — please try again shortly',
        message: 'Generation capacity temporarily exceeded — please try again shortly',
        code: 'GENERATION_CAPACITY_EXCEEDED',
      });
    }

    const maxConcurrent = this.config.get('MAX_CONCURRENT_GENERATIONS_PER_USER', { infer: true });
    const activeCount = await this.generationRunService.countActiveForUser(userId);
    if (activeCount >= maxConcurrent) {
      throw new ConflictException({
        error: 'You already have the maximum number of books generating at once',
        message: 'You already have the maximum number of books generating at once',
        code: 'GENERATION_CONCURRENCY_LIMIT',
      });
    }

    const windowMs = this.config.get('GENERATION_USER_WINDOW_MS', { infer: true });
    const maxPerWindow = this.config.get('MAX_GENERATIONS_PER_USER_PER_WINDOW', { infer: true });
    const windowCount = await this.generationRunService.countCreatedForUserSince(
      userId,
      new Date(Date.now() - windowMs),
    );
    if (windowCount >= maxPerWindow) {
      throw new HttpException(
        {
          error: 'Generation limit reached for this period — please try again later',
          message: 'Generation limit reached for this period — please try again later',
          code: 'GENERATION_QUOTA_EXCEEDED',
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

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

  /**
   * Stores an optional child reference photo for a draft/editable book. The
   * controller's multer config only enforces size and a client-supplied
   * Content-Type header (`!file` here means multer's fileFilter rejected
   * that header outright) — neither is trustworthy on its own, so
   * ChildPhotoProcessor decodes the bytes for real (magic-byte/container
   * validation via sharp/libvips), enforces a pixel-count ceiling, and
   * re-encodes to strip EXIF/ICC/XMP metadata (including any GPS tag) before
   * anything is persisted. Saved via ImageAssetStorage under
   * childPhotoAssetKey(bookId), the same local/cloud driver generated
   * illustrations use — never a publicly served path, and deleted only when
   * the owning book is (see BooksService.remove and Phase 3's artifact
   * cleanup work). AgentService reads it back during char_build to build the
   * CharacterProfile; re-uploading before generation starts simply overwrites
   * the previous photo.
   */
  async uploadChildPhoto(
    userId: string,
    bookId: string,
    file: Express.Multer.File | undefined,
  ): Promise<BookDto> {
    const book = await this.findOwnedOrThrow(bookId, userId);
    if (!EDITABLE_BOOK_STATUSES.has(book.status)) {
      throw new ConflictException(
        'Child photo cannot be uploaded while generation is in progress',
      );
    }
    if (!file) {
      throw new BadRequestException(
        'No photo file provided, or the file was rejected — use jpg/png/webp under 5MB',
      );
    }

    const { buffer, contentType } = await this.childPhotoProcessor.process(file.buffer);

    const key = childPhotoAssetKey(bookId);
    await this.imageAssetStorage.saveImageAsset(key, buffer, contentType);

    const updated = await this.prisma.book.update({
      where: { id: bookId },
      data: { childPhotoAssetKey: key, childPhotoContentType: contentType },
    });
    return toBookDto(updated);
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
   * Resumes a *failed* book using the exact same input the failed run used —
   * never the book's current fields, even if they were edited since the
   * failure (use regenerateBook for that). Copies inputSnapshot verbatim from
   * the book's most recent GenerationRun and links retryOfRunId to it, so
   * AgentService.isResumableBook can trust that any story/images already on
   * the row came from this same input and safely resume past whatever step
   * already succeeded. Falls back to building a fresh snapshot only for a
   * book with no GenerationRun history at all (predates Phase 2A/2B).
   * AgentService appends new AgentLog rows rather than deleting prior ones,
   * so history stays visible in generation diagnostics.
   */
  async retryGeneration(userId: string, bookId: string): Promise<GenerateBookResponse> {
    const book = await this.findOwnedOrThrow(bookId, userId);
    if (book.status !== BookStatus.failed) {
      throw new ConflictException(
        'Only failed books can be retried — use regenerate to replace a complete book',
      );
    }
    if (await this.generationRunService.findActiveForBook(bookId)) {
      throw new ConflictException('Generation is already in progress for this book');
    }
    await this.assertGenerationAllowed(userId);

    const priorRun = await this.generationRunService.findLatestForBook(bookId);
    if (!priorRun) {
      this.logger.warn(
        `Retry for book ${bookId} found no prior GenerationRun to copy input from — building a fresh snapshot from the book's current fields instead.`,
      );
    }
    const inputSnapshot = priorRun
      ? (priorRun.inputSnapshot as unknown as GenerationInputSnapshot)
      : buildInputSnapshot(book);

    const updated = await this.createRunAndSchedule({
      book,
      fromStatus: BookStatus.failed,
      kind: 'retry',
      isRetry: true,
      conflictMessage: 'Only failed books can be retried',
      inputSnapshot,
      ...(priorRun && { retryOfRunId: priorRun.id }),
    });

    return { book: toBookDto(updated) };
  }

  /**
   * Replaces a book's story/images/PDF with a fresh run built from the
   * book's *current* fields — the opposite of retryGeneration's "same input"
   * guarantee. Available for a failed book too (not just complete) so a user
   * who edited a failed book's fields, rather than just retrying, gets a run
   * that actually reflects those edits. Always builds a brand-new
   * inputSnapshot/inputHash, so AgentService.isResumableBook only resumes
   * this run's own prior output if the input truly didn't change — an edit
   * changes the hash and forces a full regeneration instead of silently
   * reusing stale content (the bug this phase's retry/regenerate split
   * fixes).
   */
  async regenerateBook(userId: string, bookId: string): Promise<GenerateBookResponse> {
    const book = await this.findOwnedOrThrow(bookId, userId);
    if (book.status !== BookStatus.failed && book.status !== BookStatus.complete) {
      throw new ConflictException('Only failed or complete books can be regenerated');
    }
    if (await this.generationRunService.findActiveForBook(bookId)) {
      throw new ConflictException('Generation is already in progress for this book');
    }
    await this.assertGenerationAllowed(userId);

    const updated = await this.createRunAndSchedule({
      book,
      fromStatus: book.status,
      kind: 'regenerate',
      isRetry: true,
      conflictMessage: 'Only failed or complete books can be regenerated',
      inputSnapshot: buildInputSnapshot(book),
    });

    return { book: toBookDto(updated) };
  }

  /**
   * Validates and transitions a draft to a non-terminal generating state,
   * then schedules AgentService's pipeline to run on the durable generation
   * queue — the HTTP response returns as soon as the status transition is
   * persisted, not once generation finishes. See GenerationRun/OutboxEvent
   * ("Generation runs" in docs/local-generation-pipeline.md).
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
    if (await this.generationRunService.findActiveForBook(bookId)) {
      throw new ConflictException('Generation is already in progress for this book');
    }
    await this.assertGenerationAllowed(userId);

    const updated = await this.createRunAndSchedule({
      book,
      fromStatus: BookStatus.created,
      kind: 'initial',
      isRetry: false,
      conflictMessage: 'Generation already started or completed for this book',
      inputSnapshot: buildInputSnapshot(book),
    });

    return { book: toBookDto(updated) };
  }

  /**
   * Atomically creates the GenerationRun, transitions the Book, and writes
   * the OutboxEvent that will get it dispatched to BullMQ — all in one DB
   * transaction, replacing the old three-separate-writes sequence (Book
   * status claim, then a GenerationJob insert, then a direct BullMQ
   * `queue.add`) that could leave a book stuck mid-transition if the process
   * crashed between steps. Two independent guards make a racing concurrent
   * call fail cleanly instead of double-scheduling:
   *   - the conditional `Book.update({ where: { status: fromStatus } })`,
   *     same mechanism as before (P2025 on a lost race);
   *   - the DB-level partial unique index on GenerationRun (P2002 — see
   *     isOneActiveRunViolation), which is the real source of truth for "at
   *     most one active run per book" now, independent of Book.activeRunId.
   * The actual BullMQ publish is deliberately NOT done here — see
   * OutboxDispatcherService — so a crash right after this transaction commits
   * can never lose the dispatch.
   */
  private async createRunAndSchedule(params: {
    book: Book;
    fromStatus: BookStatus;
    kind: GenerationRunKind;
    isRetry: boolean;
    conflictMessage: string;
    inputSnapshot: GenerationInputSnapshot;
    retryOfRunId?: string;
  }): Promise<Book> {
    const inputHash = hashInputSnapshot(params.inputSnapshot);

    let created: { book: Book; run: GenerationRun };
    try {
      created = await this.prisma.$transaction(async (tx) => {
        const run = await tx.generationRun.create({
          data: {
            bookId: params.book.id,
            userId: params.book.userId,
            kind: params.kind,
            inputSnapshot: params.inputSnapshot as unknown as Prisma.InputJsonValue,
            inputHash,
            ...(params.retryOfRunId && { retryOfRunId: params.retryOfRunId }),
          },
        });
        const updatedBook = await tx.book.update({
          where: { id: params.book.id, status: params.fromStatus },
          data: {
            status: GENERATION_STARTED_STATUS,
            activeRunId: run.id,
            failedStep: null,
            errorMessage: null,
            ...(params.isRetry && { retryCount: { increment: 1 } }),
          },
        });
        await tx.outboxEvent.create({
          data: {
            aggregateType: 'generation_run',
            aggregateId: run.id,
            eventType: 'run_queued',
            payload: { bookId: params.book.id, runId: run.id } as unknown as Prisma.InputJsonValue,
          },
        });
        return { book: updatedBook, run };
      });
    } catch (err) {
      if (isOneActiveRunViolation(err) || isRecordNotFound(err)) {
        throw new ConflictException(params.conflictMessage);
      }
      throw err;
    }

    this.logger.log(
      `Book ${params.book.id} status ${params.fromStatus} -> ${created.book.status}; run ${created.run.id} (${params.kind}) queued`,
    );

    // Best-effort legacy diagnostics mirror (see GenerationJobService's own
    // doc comment) — GenerationRun, created above inside the transaction, is
    // now the sole source of truth for dispatch and concurrency; a failure
    // here never blocks or fails the request.
    await this.generationJobService
      .createQueued({
        bookId: params.book.id,
        userId: params.book.userId,
        type: params.isRetry ? GenerationJobType.retry : GenerationJobType.generate,
        attempt: created.book.retryCount + 1,
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.error(
          `Failed to create legacy diagnostics GenerationJob for book ${params.book.id}: ${message}`,
        );
      });

    return created.book;
  }

  /**
   * Runs AgentService's pipeline for one claimed GenerationRun — invoked by
   * GenerationQueueProcessor (the BullMQ worker) only after
   * GenerationRunService.claim has already fenced this call in, outside any
   * HTTP request. Reloads the book fresh from the database rather than
   * trusting a caller-supplied object, since a durable queue job can run in a
   * different process, or after a delay, from whenever it was enqueued.
   *
   * AgentService already marks the book failed for every failure it
   * anticipates (story generation, image generation, PDF render) — that is
   * treated as an ordinary, expected outcome here (`completeRun('failed')`).
   * An error AgentService itself doesn't catch is, by construction,
   * unexpected — a bug, a DB blip, a Redis hiccup — exactly the class BullMQ's
   * own attempts/backoff (DEFAULT_JOB_OPTIONS, queue.module.ts) exists to
   * retry: this rethrows rather than swallowing, so that retry actually
   * happens, instead of every transient failure requiring the user to click
   * retry manually. See GenerationQueueProcessor.onFailed for what happens
   * once BullMQ's own attempts are exhausted.
   */
  async runGenerationPipeline(bookId: string, run: GenerationRun): Promise<void> {
    this.logger.log(`Starting generation pipeline — bookId=${bookId} runId=${run.id}`);

    const legacyJob = await this.generationJobService.findActive(bookId).catch(() => null);
    if (legacyJob) {
      await this.markJob(this.generationJobService.markRunning(legacyJob.id), legacyJob.id, bookId, 'running');
    }

    let result: Book;
    try {
      const book = await this.prisma.book.findUniqueOrThrow({ where: { id: bookId } });
      result = await this.agentService.startBookGeneration(book, run.inputHash);
      this.logger.log(`Book ${bookId} status ${book.status} -> ${result.status} (run ${run.id})`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `Generation pipeline threw unexpectedly for run ${run.id} (book ${bookId}): ${message}`,
      );
      if (legacyJob) {
        await this.markJob(
          this.generationJobService.markFailed(legacyJob.id, { errorMessage: message }),
          legacyJob.id,
          bookId,
          'failed',
        );
      }
      // Deliberately does not touch GenerationRun/Book status — see this
      // method's doc comment. Rethrow so BullMQ retries.
      throw err;
    }

    if (result.status === BookStatus.failed) {
      await this.completeRun(run, 'failed', {
        errorCode: 'GENERATION_FAILED',
        errorMessage: result.errorMessage ?? 'Generation failed',
      });
      if (legacyJob) {
        await this.markJob(
          this.generationJobService.markFailed(legacyJob.id, {
            errorMessage: result.errorMessage ?? 'Generation failed',
            failedStep: result.failedStep,
          }),
          legacyJob.id,
          bookId,
          'failed',
        );
      }
    } else {
      await this.completeRun(run, 'completed');
      if (legacyJob) {
        await this.markJob(
          this.generationJobService.markCompleted(legacyJob.id),
          legacyJob.id,
          bookId,
          'completed',
        );
      }
    }
  }

  /**
   * Guarded terminal transition for a claimed run: only takes effect if the
   * run is still `running` with the exact `fencingVersion` this worker
   * observed at claim time — if recovery (or a later claim) already moved it
   * on, this is a safe no-op, and Book.activeRunId/publishedRunId are left
   * untouched too (their own update is guarded on `activeRunId = run.id`).
   * On success, Book.publishedRunId is set — the last successful run stays
   * published even if a later run is started and fails (invariant G); on
   * failure, only activeRunId is cleared, `Book.status`/`errorMessage`/
   * `failedStep` are left exactly as AgentService itself already wrote them.
   */
  private async completeRun(
    run: GenerationRun,
    outcome: 'completed' | 'failed',
    failureDetails?: { errorCode: string; errorMessage: string },
  ): Promise<void> {
    const fenceWhere = {
      id: run.id,
      status: GenerationRunStatus.running,
      fencingVersion: run.fencingVersion,
    };
    const claimedStillValid =
      outcome === 'completed'
        ? await this.prisma.generationRun.updateMany({
            where: fenceWhere,
            data: { status: GenerationRunStatus.completed, completedAt: new Date() },
          })
        : await this.prisma.generationRun.updateMany({
            where: fenceWhere,
            data: {
              status: GenerationRunStatus.failed,
              failedAt: new Date(),
              // completeRun('failed', ...) is only ever called with failureDetails set (see both call sites below).
              errorCode: failureDetails?.errorCode ?? 'GENERATION_FAILED',
              errorMessage: failureDetails?.errorMessage ?? 'Generation failed',
            },
          });

    if (claimedStillValid.count === 0) {
      this.logger.warn(
        `Run ${run.id} (book ${run.bookId}) finished ${outcome} but its fencing guard found it already superseded — not touching Book.`,
      );
      return;
    }

    await this.prisma.book.updateMany({
      where: { id: run.bookId, activeRunId: run.id },
      data:
        outcome === 'completed'
          ? { activeRunId: null, publishedRunId: run.id }
          : { activeRunId: null },
    });
  }

  /**
   * Called from GenerationQueueProcessor.onFailed once BullMQ has exhausted
   * every attempt for a run's job — the backstop for "an unexpected/infra
   * error kept recurring and no more retries are coming," so the book is
   * never left stuck in a non-terminal status indefinitely. A no-op if the
   * run isn't `running` anymore (already finalized by a normal completion,
   * or already reclaimed) — checked via the same fencing guard as
   * completeRun. Phase 2C's recovery sweep is the equivalent backstop for a
   * whole worker *process* dying mid-attempt, as opposed to a single job
   * exhausting its retries while the process stays up.
   */
  async markRunPermanentlyFailedAfterExhaustedRetries(runId: string): Promise<void> {
    const run = await this.prisma.generationRun.findUnique({ where: { id: runId } });
    if (!run || run.status !== GenerationRunStatus.running) return;

    const safeMessage = 'Generation failed after repeated errors — please retry.';
    const updated = await this.prisma.generationRun.updateMany({
      where: { id: run.id, status: GenerationRunStatus.running, fencingVersion: run.fencingVersion },
      data: {
        status: GenerationRunStatus.failed,
        failedAt: new Date(),
        errorCode: 'GENERATION_INFRASTRUCTURE_FAILURE',
        errorMessage: safeMessage,
      },
    });
    if (updated.count === 0) return;

    await this.prisma.book.updateMany({
      where: { id: run.bookId, activeRunId: run.id },
      data: { activeRunId: null, status: BookStatus.failed, errorMessage: safeMessage },
    });

    const legacyJob = await this.generationJobService.findActive(run.bookId).catch(() => null);
    if (legacyJob) {
      await this.markJob(
        this.generationJobService.markFailed(legacyJob.id, { errorMessage: safeMessage }),
        legacyJob.id,
        run.bookId,
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
    const keyPresent = book.previewPdfUrl != null;
    const [logs, latestJob, previewAvailable, queue] = await Promise.all([
      this.prisma.agentLog.findMany({
        where: { bookId },
        orderBy: { createdAt: 'desc' },
        take: 20,
      }),
      this.generationJobService.findLatest(bookId),
      // Only worth checking the storage backend if the book even claims a
      // PDF was saved — avoids a network/disk round-trip for every book that
      // hasn't reached that step yet.
      keyPresent ? this.pdfStorage.previewPdfExists(bookId) : Promise.resolve(false),
      this.generationQueueService.getQueueDiagnostics(),
    ]);
    return buildGenerationDiagnostics(
      book,
      logs,
      latestJob,
      {
        driver: this.pdfStorage.driver,
        keyPresent,
        previewAvailable: keyPresent && previewAvailable,
      },
      queue,
    );
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
