import {
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BookStatus, GenerationRunStatus, type Book } from '@prisma/client';
import {
  type BookDto,
  type BooksPageDto,
  type CancelGenerationResponse,
  type GenerateBookResponse,
  type GenerationDiagnosticsDto,
} from '@book/types';
import type { Env } from '../config/env.schema';
import { PrismaService } from '../database/prisma.service';
import { CreditsService } from '../credits/credits.service';
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
  STORY_GENERATION_PROVIDER_TOKEN,
  type StoryGenerationProvider,
} from '../agent/story-generation-provider';
import {
  CHARACTER_PROFILE_PROVIDER_TOKEN,
  type CharacterProfileProvider,
} from '../agent/character-profile-provider';
import { PDF_STORAGE_TOKEN, type PdfStorage } from '../pdf/pdf-storage';
import { RATE_LIMITER_TOKEN, type RateLimiter } from '../rate-limit/rate-limiter.interface';
import { IMAGE_ASSET_STORAGE_TOKEN, type ImageAssetStorage } from '../images/image-asset-storage';
import { ChildPhotoProcessor } from '../images/child-photo-processor';
import {
  IMAGE_GENERATION_PROVIDER_TOKEN,
  type ImageGenerationProvider,
} from '../images/image-generation-provider';
import { toBookDto } from './books.mapper';
import type { CreateBookDto } from './dto/create-book.dto';
import type { UpdateBookDto } from './dto/update-book.dto';
import { BookCrudService } from './book-crud.service';
import { BookAssetService } from './book-asset.service';
import { BookDiagnosticsService } from './book-diagnostics.service';
import { BookGenerationService } from './book-generation.service';

export {
  IMAGE_GENERATION_BUDGET_INSUFFICIENT_CODE,
  PAID_PROVIDER_CALL_BUDGET_INSUFFICIENT_CODE,
} from './book-generation.service';

/** Phase G1: stable code for a repeated POST /books/:id/cancel — see API_SPEC.md. */
export const BOOK_ALREADY_CANCELLED_CODE = 'BOOK_ALREADY_CANCELLED';
/** Phase G1: stable code for POST /books/:id/cancel on a book with no active (queued/running) run — created/complete/failed/partial all land here. */
export const BOOK_NOT_IN_PROGRESS_CODE = 'BOOK_NOT_IN_PROGRESS';

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
  private readonly diagnosticsService: BookDiagnosticsService;
  private readonly generationService: BookGenerationService;

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
    @Optional() diagnosticsService?: BookDiagnosticsService,
    @Optional() generationService?: BookGenerationService,
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
    this.diagnosticsService =
      diagnosticsService ??
      new BookDiagnosticsService(
        this.crudService,
        prisma,
        generationRunService,
        generationQueueService,
        pdfStorage,
      );
    this.generationService =
      generationService ??
      new BookGenerationService(
        this.crudService,
        prisma,
        generationJobService,
        generationRunService,
        snapshotBackfill,
        config,
        rateLimiter,
        creditsService,
        imageGenerationProvider,
        storyGenerationProvider,
        characterProfileProvider,
      );
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
    return this.generationService.retryGeneration(userId, bookId);
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
    return this.generationService.regenerateBook(userId, bookId);
  }

  /**
   * Validates and transitions a draft to a non-terminal generating state,
   * then schedules AgentService's pipeline to run on the durable generation
   * queue — the HTTP response returns as soon as the status transition is
   * persisted, not once generation finishes. See GenerationRun/OutboxEvent
   * ("Generation runs" in docs/local-generation-pipeline.md).
   */
  async startGeneration(userId: string, bookId: string): Promise<GenerateBookResponse> {
    return this.generationService.startGeneration(userId, bookId);
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
    return this.diagnosticsService.getGenerationDiagnostics(bookId, userId);
  }

  /** Looks up a book and verifies ownership in one query — 404s rather than leaking existence of another user's book. */
  private async findOwnedOrThrow(id: string, userId: string): Promise<Book> {
    return this.crudService.findOwnedOrThrow(id, userId);
  }
}
