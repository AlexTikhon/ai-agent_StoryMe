import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
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
  type BookDto,
  type BooksPageDto,
  type CancelGenerationResponse,
  type GenerateBookResponse,
  type GenerationDiagnosticsDto,
} from '@book/types';
import type { Env } from '../config/env.schema';
import { PrismaService } from '../database/prisma.service';
import {
  CreditsService,
  GENERATION_CREDIT_COST,
  generationChargeIdempotencyKey,
} from '../credits/credits.service';
import { AgentService } from '../agent/agent.service';
import { GenerationQueueService } from '../agent/generation-queue.service';
import { GenerationJobService } from '../agent/generation-job.service';
import { GenerationRunService } from '../agent/generation-run.service';
import { StaleGenerationRunError } from '../agent/generation-execution.service';
import {
  GenerationRunCoordinator,
  GenerationRunMirrorInvariantError,
} from '../agent/generation-run-coordinator.service';
import { GenerationInputSnapshotBackfillService } from '../agent/generation-input-snapshot-backfill.service';
import type { GenerationExecutionContext } from '../agent/generation-execution-context';
import type { GenerationOutcome } from '../agent/generation-outcome';
import {
  assertPaidProviderCallBudget,
  requiredPaidProviderCallsForBook,
} from '../agent/generation-provider-telemetry';
import {
  STORY_GENERATION_PROVIDER_TOKEN,
  type StoryGenerationProvider,
} from '../agent/story-generation-provider';
import {
  CHARACTER_PROFILE_PROVIDER_TOKEN,
  type CharacterProfileProvider,
} from '../agent/character-profile-provider';
import {
  buildInputSnapshot,
  hashInputSnapshot,
  GENERATION_INPUT_SNAPSHOT_INVALID,
  InvalidGenerationInputSnapshotError,
  type GenerationInputSnapshot,
} from '../agent/generation-input-snapshot';
import { publishedPreviewPdfExists, PDF_STORAGE_TOKEN, type PdfStorage } from '../pdf/pdf-storage';
import { resolvePublishedPdfNamespace } from '../agent/generation-artifact-namespace';
import { RATE_LIMITER_TOKEN, type RateLimiter } from '../rate-limit/rate-limiter.interface';
import { IMAGE_ASSET_STORAGE_TOKEN, type ImageAssetStorage } from '../images/image-asset-storage';
import { ChildPhotoProcessor } from '../images/child-photo-processor';
import {
  assertCompleteBookImageBudget,
  IMAGE_GENERATION_PROVIDER_TOKEN,
  requiredGeneratedImagesForBook,
  type ImageGenerationProvider,
} from '../images/image-generation-provider';
import { toBookDto } from './books.mapper';
import { buildGenerationDiagnostics } from './generation-diagnostics';
import type { CreateBookDto } from './dto/create-book.dto';
import type { UpdateBookDto } from './dto/update-book.dto';
import { BookCrudService } from './book-crud.service';
import { BookAssetService } from './book-asset.service';

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

/** Phase G1: stable code for a repeated POST /books/:id/cancel — see API_SPEC.md. */
export const BOOK_ALREADY_CANCELLED_CODE = 'BOOK_ALREADY_CANCELLED';
/** Phase G1: stable code for POST /books/:id/cancel on a book with no active (queued/running) run — created/complete/failed/partial all land here. */
export const BOOK_NOT_IN_PROGRESS_CODE = 'BOOK_NOT_IN_PROGRESS';
export const IMAGE_GENERATION_BUDGET_INSUFFICIENT_CODE = 'IMAGE_GENERATION_BUDGET_INSUFFICIENT';
export const PAID_PROVIDER_CALL_BUDGET_INSUFFICIENT_CODE = 'PAID_PROVIDER_CALL_BUDGET_INSUFFICIENT';

function alreadyCancelledException(): HttpException {
  return new HttpException(
    {
      error: 'Book generation already cancelled',
      message: 'Book generation already cancelled',
      code: BOOK_ALREADY_CANCELLED_CODE,
    },
    HttpStatus.CONFLICT,
  );
}

function notInProgressException(): HttpException {
  return new HttpException(
    {
      error: 'Book is not currently generating',
      message: 'Book is not currently generating',
      code: BOOK_NOT_IN_PROGRESS_CODE,
    },
    HttpStatus.CONFLICT,
  );
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
@Injectable()
export class BooksService {
  private readonly logger = new Logger(BooksService.name);
  private readonly crudService: BookCrudService;
  private readonly assetService: BookAssetService;

  constructor(
    private readonly prisma: PrismaService,
    private readonly agentService: AgentService,
    @Inject(PDF_STORAGE_TOKEN) private readonly pdfStorage: PdfStorage,
    @Inject(IMAGE_ASSET_STORAGE_TOKEN) private readonly imageAssetStorage: ImageAssetStorage,
    private readonly generationQueueService: GenerationQueueService,
    private readonly generationJobService: GenerationJobService,
    private readonly generationRunService: GenerationRunService,
    private readonly generationRunCoordinator: GenerationRunCoordinator,
    private readonly snapshotBackfill: GenerationInputSnapshotBackfillService,
    private readonly config: ConfigService<Env, true>,
    @Inject(RATE_LIMITER_TOKEN) private readonly rateLimiter: RateLimiter,
    private readonly childPhotoProcessor: ChildPhotoProcessor,
    private readonly creditsService: CreditsService,
    @Inject(IMAGE_GENERATION_PROVIDER_TOKEN)
    private readonly imageGenerationProvider: ImageGenerationProvider,
    @Inject(STORY_GENERATION_PROVIDER_TOKEN)
    private readonly storyGenerationProvider: StoryGenerationProvider,
    @Inject(CHARACTER_PROFILE_PROVIDER_TOKEN)
    private readonly characterProfileProvider: CharacterProfileProvider,
    @Optional() crudService?: BookCrudService,
    @Optional() assetService?: BookAssetService,
  ) {
    this.crudService = crudService ?? new BookCrudService(prisma);
    this.assetService =
      assetService ??
      new BookAssetService(
        this.crudService,
        prisma,
        pdfStorage,
        imageAssetStorage,
        childPhotoProcessor,
      );
  }

  /**
   * Refuses an incomplete paid run before the GenerationRun/credit/outbox
   * transaction begins. A per-book credit represents a complete PDF, so
   * spending provider budget on only the first N illustrations is never a
   * valid degraded outcome.
   */
  private assertCompleteImageBudget(inputSnapshot: GenerationInputSnapshot): void {
    if (this.imageGenerationProvider.providerName !== 'openai') return;

    const requiredImages = requiredGeneratedImagesForBook(inputSnapshot.pageCount);
    const configuredLimit = this.config.get('MAX_GENERATED_IMAGES_PER_BOOK', { infer: true });
    try {
      assertCompleteBookImageBudget(requiredImages, configuredLimit);
    } catch {
      throw new ServiceUnavailableException({
        error: 'Image generation capacity is temporarily unavailable',
        message: 'Image generation capacity is temporarily unavailable',
        code: IMAGE_GENERATION_BUDGET_INSUFFICIENT_CODE,
      });
    }
  }

  /** Refuses a run whose complete paid-provider plan exceeds the operator cap. */
  private assertPaidProviderCallBudget(inputSnapshot: GenerationInputSnapshot): void {
    const requiredCalls = requiredPaidProviderCallsForBook(
      inputSnapshot.pageCount ?? DEFAULT_BOOK_PAGE_COUNT,
      {
        storyProvider: this.storyGenerationProvider.providerName,
        characterProfileProvider: this.characterProfileProvider.providerName,
        imageProvider: this.imageGenerationProvider.providerName,
      },
    );
    const configuredLimit = this.config.get('MAX_PAID_PROVIDER_CALLS_PER_RUN', {
      infer: true,
    });
    try {
      assertPaidProviderCallBudget(requiredCalls, configuredLimit);
    } catch {
      throw new ServiceUnavailableException({
        error: 'Generation provider capacity is temporarily unavailable',
        message: 'Generation provider capacity is temporarily unavailable',
        code: PAID_PROVIDER_CALL_BUDGET_INSUFFICIENT_CODE,
      });
    }
  }

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
    return this.crudService.create(userId, dto);
  }

  /**
   * Stores an optional child reference photo for a draft/editable book. The
   * controller's multer config only enforces size and a client-supplied
   * Content-Type header (`!file` here means multer's fileFilter rejected
   * that header outright) — neither is trustworthy on its own, so
   * ChildPhotoProcessor decodes the bytes for real (magic-byte/container
   * validation via sharp/libvips), enforces a pixel-count ceiling, and
   * re-encodes to strip EXIF/ICC/XMP metadata (including any GPS tag) before
   * anything is persisted.
   *
   * Every upload mints a fresh, versioned ImageAssetStorage key
   * (childPhotoAssetKey(bookId, version)) rather than overwriting a fixed
   * one — a GenerationInputSnapshot freezes a specific version's key/digest,
   * so re-uploading must never mutate bytes an already-created run may still
   * reference (old versions are simply left as unreferenced objects for now;
   * systematic cleanup is a later phase). The sha256 digest and byte size are
   * recorded alongside so the run snapshot can carry a full immutable photo
   * identity, not just a mutable key.
   *
   * The Book write is a conditional (CAS) update gated on the book still
   * being in an editable status — the earlier `EDITABLE_BOOK_STATUSES` check
   * above is a fast-path rejection, not the actual race guard, since
   * generation could start between that read and this write.
   */
  async uploadChildPhoto(
    userId: string,
    bookId: string,
    file: Express.Multer.File | undefined,
  ): Promise<BookDto> {
    return this.assetService.uploadChildPhoto(userId, bookId, file);
  }

  async findAllForUser(userId: string, page: number, limit: number): Promise<BooksPageDto> {
    return this.crudService.findAllForUser(userId, page, limit);
  }

  async findOneForUser(id: string, userId: string): Promise<BookDto> {
    return this.crudService.findOneForUser(id, userId);
  }

  /**
   * The initial status check below is a fast-path rejection for the common
   * case (returns a clean 409 for an obviously-in-progress book without a
   * wasted write attempt) — it is not what actually prevents the race
   * against `createRunAndSchedule`'s status transition. The CAS `updateMany`
   * (status re-checked in the WHERE clause) is: generation starting between
   * this method's read and its write makes the write match zero rows, which
   * is treated as the same conflict rather than silently mutating a book
   * whose generation has already begun.
   */
  async update(id: string, userId: string, dto: UpdateBookDto): Promise<BookDto> {
    return this.crudService.update(id, userId, dto);
  }

  /** See update()'s doc comment — same CAS reasoning applies to soft-delete. */
  async remove(id: string, userId: string): Promise<void> {
    return this.crudService.remove(id, userId);
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
    let inputSnapshot: GenerationInputSnapshot;
    if (priorRun) {
      try {
        // .snapshot only — createRunAndSchedule below always recomputes
        // inputHash fresh from whatever inputSnapshot it's given, so the new
        // run's hash is self-consistent regardless (see
        // GenerationInputSnapshotBackfillService's snapshot/hash invariant
        // doc comment for why that pairing matters at all).
        inputSnapshot = (await this.snapshotBackfill.normalize(priorRun)).snapshot;
      } catch (err) {
        if (!(err instanceof InvalidGenerationInputSnapshotError)) throw err;
        // Predictable, safe failure (never the raw Zod issue list) rather
        // than an unhandled 500 — see GENERATION_INPUT_SNAPSHOT_INVALID's own
        // doc comment. regenerateBook is the escape hatch: it always builds a
        // fresh snapshot from the book's current fields instead of copying
        // the corrupted prior one.
        throw new ConflictException({
          error:
            "This book's prior generation request is corrupted and cannot be retried — use regenerate instead.",
          message:
            "This book's prior generation request is corrupted and cannot be retried — use regenerate instead.",
          code: GENERATION_INPUT_SNAPSHOT_INVALID,
        });
      }
    } else {
      inputSnapshot = buildInputSnapshot(book);
    }

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
   *
   * Phase G1: also available for a `cancelled` book — the documented way to
   * start a fresh attempt after a user-initiated cancellation. This new run
   * is independently charged (createRunAndSchedule's usual
   * GENERATION_CREDIT_COST debit), regardless of whether the cancelled run
   * it replaces was refunded. `retryGeneration` deliberately does NOT accept
   * `cancelled` — retry remains specific to resuming a *failed* run's exact
   * input; a cancellation was voluntary, not a failure to resume.
   */
  async regenerateBook(userId: string, bookId: string): Promise<GenerateBookResponse> {
    const book = await this.findOwnedOrThrow(bookId, userId);
    if (
      book.status !== BookStatus.failed &&
      book.status !== BookStatus.complete &&
      book.status !== BookStatus.cancelled
    ) {
      throw new ConflictException('Only failed, complete, or cancelled books can be regenerated');
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
      conflictMessage: 'Only failed, complete, or cancelled books can be regenerated',
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
   * Phase G1 — POST /books/:id/cancel. Delegates the entire fenced
   * cancellation transaction to GenerationRunCoordinator.cancelGeneration
   * (see its own doc comment for the exact ordering: ownership verification,
   * fenced run transition, Book mirror update, outbox suppression, and
   * conditional refund, all inside one transaction) and maps its typed
   * CancelGenerationOutcome onto this endpoint's stable HTTP contract. Two
   * follow-ups run only after that transaction has already committed, are
   * both best-effort, and can never roll back or fail an already-applied
   * cancellation:
   *   - the legacy GenerationJob diagnostics mirror is marked cancelled only
   *     now, never before (GenerationJob is not authoritative — see
   *     markJob's own doc comment, reused here);
   *   - GenerationQueueService.removeIfSafe best-effort removes a
   *     still-waiting/delayed BullMQ job; an active one is deliberately left
   *     alone (see that method's own doc comment for why the committed DB
   *     fencing above, not queue removal, is the actual correctness
   *     mechanism).
   */
  async cancelGeneration(userId: string, bookId: string): Promise<CancelGenerationResponse> {
    const result = await this.generationRunCoordinator.cancelGeneration({ bookId, userId });

    switch (result.kind) {
      case 'not_found':
        throw new NotFoundException('Book not found');
      case 'already_cancelled':
        throw alreadyCancelledException();
      case 'not_in_progress':
        throw notInProgressException();
      case 'book_mirror_mismatch':
        throw new GenerationRunMirrorInvariantError(result.runId, result.bookId);
      case 'applied':
        break;
    }

    const legacyJob = await this.generationJobService.findActive(bookId).catch(() => null);
    if (legacyJob) {
      await this.markJob(
        this.generationJobService.markCancelled(legacyJob.id),
        legacyJob.id,
        bookId,
        'cancelled',
      );
    }
    await this.generationQueueService.removeIfSafe(result.runId);

    return { book: toBookDto(result.book), creditsRefunded: result.creditsRefunded };
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
   *
   * Phase E2: every newly created run also charges GENERATION_CREDIT_COST
   * credits here, inside this same transaction, via
   * CreditsService.deductInTransaction keyed on
   * generationChargeIdempotencyKey(run.id) — a user with insufficient
   * balance gets the stable 402 INSUFFICIENT_CREDITS error and this whole
   * transaction rolls back, leaving no run, no Book transition, and no
   * OutboxEvent, exactly as if scheduling had never been attempted. Credits
   * are charged the moment a run is durably scheduled, not when generation
   * completes — see apps/api/docs/credits.md, "Phase E2".
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
    this.assertCompleteImageBudget(params.inputSnapshot);
    this.assertPaidProviderCallBudget(params.inputSnapshot);
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
        await this.creditsService.deductInTransaction(tx, {
          userId: params.book.userId,
          amount: GENERATION_CREDIT_COST,
          reason: 'book_creation',
          bookId: params.book.id,
          idempotencyKey: generationChargeIdempotencyKey(run.id),
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
   * HTTP request. Builds the GenerationExecutionContext from the run's own
   * validated inputSnapshot (never the live Book row's mutable fields — see
   * GenerationExecutionContext's doc comment) and passes that through to
   * AgentService.
   *
   * AgentService already computes a failed GenerationOutcome for every
   * failure it anticipates (story generation, image generation, PDF render)
   * — that is treated as an ordinary, expected outcome here, published via
   * GenerationRunCoordinator.completeRun exactly like a success.
   * StaleGenerationRunError means a newer claim/recovery already superseded
   * this attempt mid-pipeline — logged and swallowed, not rethrown, since
   * whichever attempt owns the run now is responsible for its own
   * completion; retrying would only race it. Any other error AgentService
   * itself doesn't catch is, by construction, unexpected — a bug, a DB blip,
   * a Redis hiccup — exactly the class BullMQ's own attempts/backoff
   * (DEFAULT_JOB_OPTIONS, queue.module.ts) exists to retry: this rethrows
   * rather than swallowing, so that retry actually happens, instead of every
   * transient failure requiring the user to click retry manually. See
   * GenerationQueueProcessor.onFailed for what happens once BullMQ's own
   * attempts are exhausted.
   *
   * completeRun's result gates the legacy GenerationJob update below: a
   * 'stale_fence' means a different, still-live attempt for the same book
   * owns that diagnostics row now, so this attempt quietly returns.
   * 'book_mirror_mismatch' is not a race — it means the run/Book mirror
   * invariant itself is broken — so it is rethrown as
   * GenerationRunMirrorInvariantError instead, the same way an unexpected
   * pipeline error above is: so BullMQ never treats this delivery as
   * completed, and the exhausted-retries backstop eventually reconciles it.
   */
  async runGenerationPipeline(ctx: GenerationExecutionContext): Promise<void> {
    const { bookId, runId } = ctx;
    this.logger.log(`Starting generation pipeline — bookId=${bookId} runId=${runId}`);

    const legacyJob = await this.generationJobService.findActive(bookId).catch(() => null);
    if (legacyJob) {
      await this.markJob(
        this.generationJobService.markRunning(legacyJob.id),
        legacyJob.id,
        bookId,
        'running',
      );
    }

    let outcome: GenerationOutcome;
    try {
      outcome = await this.agentService.startBookGeneration(ctx);
      this.logger.log(`Book ${bookId} pipeline outcome -> ${outcome.status} (run ${runId})`);
    } catch (err) {
      if (err instanceof StaleGenerationRunError) {
        this.logger.warn(
          `Run ${runId} (book ${bookId}) was superseded mid-pipeline — abandoning this attempt without touching Book/GenerationRun further: ${err.message}`,
        );
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `Generation pipeline threw unexpectedly for run ${runId} (book ${bookId}): ${message}`,
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

    const published = await this.generationRunCoordinator.completeRun(ctx, outcome);
    if (published === 'book_mirror_mismatch') {
      throw new GenerationRunMirrorInvariantError(runId, bookId);
    }
    if (published !== 'applied') return;

    if (legacyJob) {
      if (outcome.status === BookStatus.failed) {
        await this.markJob(
          this.generationJobService.markFailed(legacyJob.id, {
            errorMessage: outcome.errorMessage ?? 'Generation failed',
            ...(outcome.failedStep !== undefined && { failedStep: outcome.failedStep }),
          }),
          legacyJob.id,
          bookId,
          'failed',
        );
      } else {
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
   * Called from GenerationQueueProcessor.onFailed once BullMQ has exhausted
   * every attempt for a run's job — the backstop for "an unexpected/infra
   * error kept recurring and no more retries are coming," so the book is
   * never left stuck in a non-terminal status indefinitely. A no-op if the
   * run isn't `running` anymore (already finalized by a normal completion,
   * or already reclaimed) — that early read is this method's own policy
   * decision (only a BullMQ-exhausted, still-`running` claim is this
   * backstop's concern); the actual fenced GenerationRun+Book transition is
   * GenerationRunCoordinator.failAbandoned, shared with
   * GenerationRunRecoveryService's abandoned-run sweep below. Phase 2C's
   * recovery sweep is the equivalent backstop for a whole worker *process*
   * dying mid-attempt, as opposed to a single job exhausting its retries
   * while the process stays up.
   */
  async markRunPermanentlyFailedAfterExhaustedRetries(runId: string): Promise<void> {
    const run = await this.prisma.generationRun.findUnique({ where: { id: runId } });
    if (!run || run.status !== GenerationRunStatus.running) return;

    const safeMessage = 'Generation failed after repeated errors — please retry.';
    const result = await this.generationRunCoordinator.failAbandoned(
      {
        runId: run.id,
        bookId: run.bookId,
        fencingVersion: run.fencingVersion,
        fromStatus: GenerationRunStatus.running,
      },
      { errorCode: 'GENERATION_INFRASTRUCTURE_FAILURE', errorMessage: safeMessage },
    );
    if (result === 'book_mirror_mismatch') {
      // Rethrown (caught and logged by GenerationQueueProcessor.onFailed's
      // caller) rather than silently returned — a broken mirror invariant on
      // an exhausted-retries run must never look like "nothing to do" here;
      // GenerationRunRecoveryService's sweep is what eventually reconciles
      // it, since BullMQ has nothing left to redeliver.
      throw new GenerationRunMirrorInvariantError(run.id, run.bookId);
    }
    if (result !== 'applied') return;

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
    return this.assetService.getPreviewPdfBuffer(bookId, userId);
  }

  /** Safe, non-secret generation diagnostics for a book — see generation-diagnostics.ts. */
  async getGenerationDiagnostics(
    bookId: string,
    userId: string,
  ): Promise<GenerationDiagnosticsDto> {
    const book = await this.findOwnedOrThrow(bookId, userId);
    // Phase B, Slice B4: the same published-namespace resolution every other
    // production PDF read goes through — keyPresent reflects whether a
    // publication (claim or legacy) actually exists, not previewPdfUrl alone
    // (previewPdfUrl is a storage marker, not the ownership authority).
    const namespace = resolvePublishedPdfNamespace(book);
    const keyPresent = namespace.kind !== 'not_ready';
    const [logs, latestJob, previewAvailable, queue] = await Promise.all([
      this.prisma.agentLog.findMany({
        where: { bookId },
        orderBy: { createdAt: 'desc' },
        take: 20,
      }),
      this.generationJobService.findLatest(bookId),
      // Only worth checking the storage backend if a publication actually
      // exists — avoids a network/disk round-trip for every book that hasn't
      // reached that step yet.
      keyPresent
        ? publishedPreviewPdfExists(this.pdfStorage, bookId, namespace)
        : Promise.resolve(false),
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
    return this.crudService.findOwnedOrThrow(id, userId);
  }
}
