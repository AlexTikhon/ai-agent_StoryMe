import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  BookStatus,
  GenerationJobType,
  Prisma,
  type Book,
  type GenerationRun,
  type GenerationRunKind,
} from '@prisma/client';
import { DEFAULT_BOOK_PAGE_COUNT, type GenerateBookResponse } from '@book/types';
import type { Env } from '../config/env.schema';
import { PrismaService } from '../database/prisma.service';
import {
  CreditsService,
  GENERATION_CREDIT_COST,
  generationChargeIdempotencyKey,
} from '../credits/credits.service';
import { GenerationJobService } from '../agent/generation-job.service';
import { GenerationRunService } from '../agent/generation-run.service';
import { GenerationInputSnapshotBackfillService } from '../agent/generation-input-snapshot-backfill.service';
import {
  buildInputSnapshot,
  hashInputSnapshot,
  GENERATION_INPUT_SNAPSHOT_INVALID,
  InvalidGenerationInputSnapshotError,
  type GenerationInputSnapshot,
} from '../agent/generation-input-snapshot';
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
import { RATE_LIMITER_TOKEN, type RateLimiter } from '../rate-limit/rate-limiter.interface';
import {
  assertCompleteBookImageBudget,
  IMAGE_GENERATION_PROVIDER_TOKEN,
  requiredGeneratedImagesForBook,
  type ImageGenerationProvider,
} from '../images/image-generation-provider';
import { toBookDto } from './books.mapper';
import { BookCrudService } from './book-crud.service';

const GLOBAL_GENERATION_CIRCUIT_KEY = 'global-generation-circuit';
const GENERATION_STARTED_STATUS = BookStatus.char_build;

export const IMAGE_GENERATION_BUDGET_INSUFFICIENT_CODE = 'IMAGE_GENERATION_BUDGET_INSUFFICIENT';
export const PAID_PROVIDER_CALL_BUDGET_INSUFFICIENT_CODE = 'PAID_PROVIDER_CALL_BUDGET_INSUFFICIENT';

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

/**
 * Owns generation admission and the atomic scheduling boundary. The
 * GenerationRun, credit debit, Book transition, and OutboxEvent remain in one
 * interactive transaction; BullMQ publication remains outside it in the
 * outbox dispatcher.
 */
@Injectable()
export class BookGenerationService {
  private readonly logger = new Logger(BookGenerationService.name);

  constructor(
    private readonly crud: BookCrudService,
    private readonly prisma: PrismaService,
    private readonly generationJobService: GenerationJobService,
    private readonly generationRunService: GenerationRunService,
    private readonly snapshotBackfill: GenerationInputSnapshotBackfillService,
    private readonly config: ConfigService<Env, true>,
    @Inject(RATE_LIMITER_TOKEN) private readonly rateLimiter: RateLimiter,
    private readonly creditsService: CreditsService,
    @Inject(IMAGE_GENERATION_PROVIDER_TOKEN)
    private readonly imageGenerationProvider: ImageGenerationProvider,
    @Inject(STORY_GENERATION_PROVIDER_TOKEN)
    private readonly storyGenerationProvider: StoryGenerationProvider,
    @Inject(CHARACTER_PROFILE_PROVIDER_TOKEN)
    private readonly characterProfileProvider: CharacterProfileProvider,
  ) {}

  async startGeneration(userId: string, bookId: string): Promise<GenerateBookResponse> {
    const book = await this.crud.findOwnedOrThrow(bookId, userId);
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

  async retryGeneration(userId: string, bookId: string): Promise<GenerateBookResponse> {
    const book = await this.crud.findOwnedOrThrow(bookId, userId);
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
        inputSnapshot = (await this.snapshotBackfill.normalize(priorRun)).snapshot;
      } catch (err) {
        if (!(err instanceof InvalidGenerationInputSnapshotError)) throw err;
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

  async regenerateBook(userId: string, bookId: string): Promise<GenerateBookResponse> {
    const book = await this.crud.findOwnedOrThrow(bookId, userId);
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

  private assertPaidProviderCallBudget(inputSnapshot: GenerationInputSnapshot): void {
    const requiredCalls = requiredPaidProviderCallsForBook(
      inputSnapshot.pageCount ?? DEFAULT_BOOK_PAGE_COUNT,
      {
        storyProvider: this.storyGenerationProvider.providerName,
        characterProfileProvider: this.characterProfileProvider.providerName,
        imageProvider: this.imageGenerationProvider.providerName,
      },
    );
    const configuredLimit = this.config.get('MAX_PAID_PROVIDER_CALLS_PER_RUN', { infer: true });
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
    if ((await this.generationRunService.countActiveForUser(userId)) >= maxConcurrent) {
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
}
