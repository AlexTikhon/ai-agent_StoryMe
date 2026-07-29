import { BadRequestException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import {
  BookDeletionStatus,
  GenerationRunStatus,
  PageImageRevisionStatus,
  Prisma,
  type BookDeletionRequest,
  type UserRole,
} from '@prisma/client';
import type { BookDeletionRequestDto } from '@book/types';
import { createHash } from 'node:crypto';
import { getRequestId } from '../common/correlation/correlation-context';
import {
  CreditsService,
  generationCancellationRefundIdempotencyKey,
  generationChargeIdempotencyKey,
  pageImageRevisionChargeIdempotencyKey,
  pageImageRevisionRefundIdempotencyKey,
} from '../credits/credits.service';
import { PrismaService } from '../database/prisma.service';
import { IMAGE_ASSET_STORAGE_TOKEN, type ImageAssetStorage } from '../images/image-asset-storage';
import { OUTBOX_STATUS_CANCELLED, OUTBOX_STATUS_PENDING } from '../outbox/outbox.service';
import { PDF_STORAGE_TOKEN, type PdfStorage } from '../pdf/pdf-storage';
import { GenerationQueueService } from '../agent/generation-queue.service';

export const HARD_DELETE_CONFIRMATION_CODE = 'HARD_DELETE_CONFIRMATION_MISMATCH';

type RetryCode =
  | 'BOOK_WORK_STILL_ACTIVE'
  | 'ARTIFACT_LIST_FAILED'
  | 'ARTIFACT_DELETE_FAILED'
  | 'DATABASE_FINALIZATION_BLOCKED'
  | 'UNEXPECTED_WORKFLOW_FAILURE';

export class BookDeletionRetryableError extends Error {
  constructor(
    readonly code: RetryCode,
    readonly deletedCount = 0,
    readonly remainingCount = 0,
  ) {
    super(code);
    this.name = 'BookDeletionRetryableError';
  }
}

function ownerHash(userId: string): string {
  return createHash('sha256').update(`storyme:book-deletion-owner:v1:${userId}`).digest('hex');
}

function retentionDays(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  return Number.isInteger(value) && value >= 0 ? value : fallback;
}

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

@Injectable()
export class BookHardDeletionService {
  private readonly logger = new Logger(BookHardDeletionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly credits: CreditsService,
    private readonly queue: GenerationQueueService,
    @Inject(IMAGE_ASSET_STORAGE_TOKEN) private readonly imageStorage: ImageAssetStorage,
    @Inject(PDF_STORAGE_TOKEN) private readonly pdfStorage: PdfStorage,
  ) {}

  async request(
    userId: string,
    role: UserRole,
    bookId: string,
    confirmation: string,
  ): Promise<BookDeletionRequestDto> {
    if (confirmation !== bookId) {
      throw new BadRequestException({
        code: HARD_DELETE_CONFIRMATION_CODE,
        message: 'Permanent deletion confirmation must exactly match the book ID.',
      });
    }
    const hash = ownerHash(userId);
    const existing = await this.prisma.bookDeletionRequest.findUnique({ where: { bookId } });
    if (existing) {
      this.assertOwned(existing, hash);
      if (existing.status === BookDeletionStatus.retry_pending) {
        return this.toDto(await this.reschedule(existing));
      }
      return this.toDto(existing);
    }

    let result: {
      request: BookDeletionRequest;
      runIds: string[];
      revisionIds: string[];
    };
    try {
      result = await this.prisma.$transaction(async (tx) => {
        const book = await tx.book.findFirst({ where: { id: bookId, userId } });
        if (!book) throw new NotFoundException('Book not found');

        const [runs, revisions] = await Promise.all([
          tx.generationRun.findMany({
            where: {
              bookId,
              status: { in: [GenerationRunStatus.queued, GenerationRunStatus.running] },
            },
          }),
          tx.pageImageRevision.findMany({
            where: {
              bookId,
              status: {
                in: [PageImageRevisionStatus.queued, PageImageRevisionStatus.running],
              },
            },
          }),
        ]);

        await tx.book.update({
          where: { id: bookId },
          data: {
            deletedAt: book.deletedAt ?? new Date(),
            activeRunId: null,
            activePageImageRevisionId: null,
          },
        });
        await tx.generationRun.updateMany({
          where: {
            id: { in: runs.map((run) => run.id) },
            status: { in: [GenerationRunStatus.queued, GenerationRunStatus.running] },
          },
          data: {
            status: GenerationRunStatus.cancelled,
            cancelledAt: new Date(),
            fencingVersion: { increment: 1 },
          },
        });
        await tx.pageImageRevision.updateMany({
          where: {
            id: { in: revisions.map((revision) => revision.id) },
            status: {
              in: [PageImageRevisionStatus.queued, PageImageRevisionStatus.running],
            },
          },
          data: {
            status: PageImageRevisionStatus.failed,
            failedAt: new Date(),
            errorCode: 'BOOK_HARD_DELETE_REQUESTED',
            errorMessage: 'The owning book was permanently deleted.',
            fencingVersion: { increment: 1 },
          },
        });

        const aggregateIds = [
          ...runs.map((run) => run.id),
          ...revisions.map((revision) => revision.id),
        ];
        if (aggregateIds.length > 0) {
          await tx.outboxEvent.updateMany({
            where: {
              aggregateId: { in: aggregateIds },
              status: OUTBOX_STATUS_PENDING,
            },
            data: { status: OUTBOX_STATUS_CANCELLED },
          });
        }

        for (const run of runs) {
          const charge = await tx.creditTransaction.findUnique({
            where: { idempotencyKey: generationChargeIdempotencyKey(run.id) },
          });
          if (charge) {
            await this.credits.addInTransaction(tx, {
              userId: charge.userId,
              amount: -charge.amount,
              reason: 'refund_generation_cancelled',
              ...(charge.bookId && { bookId: charge.bookId }),
              idempotencyKey: generationCancellationRefundIdempotencyKey(run.id),
            });
          }
        }
        for (const revision of revisions) {
          const charge = await tx.creditTransaction.findUnique({
            where: { idempotencyKey: pageImageRevisionChargeIdempotencyKey(revision.id) },
          });
          if (charge) {
            await this.credits.addInTransaction(tx, {
              userId: charge.userId,
              amount: -charge.amount,
              reason: 'refund_page_regeneration_failure',
              ...(charge.bookId && { bookId: charge.bookId }),
              idempotencyKey: pageImageRevisionRefundIdempotencyKey(revision.id),
            });
          }
        }

        const deletion = await tx.bookDeletionRequest.create({
          data: {
            bookId,
            ownerHash: hash,
            requestedByRole: role,
            privateDataRetentionDays: retentionDays('PRIVATE_DATA_RETENTION_DAYS', 30),
            generatedArtifactRetentionDays: retentionDays('GENERATED_ARTIFACT_RETENTION_DAYS', 30),
          },
        });
        const requestId = getRequestId();
        await tx.outboxEvent.create({
          data: {
            aggregateType: 'book_deletion',
            aggregateId: deletion.id,
            eventType: 'book_deletion_requested',
            payload: {
              bookId,
              deletionRequestId: deletion.id,
              ...(requestId && { requestId }),
            } as unknown as Prisma.InputJsonValue,
          },
        });
        return {
          request: deletion,
          runIds: runs.map((run) => run.id),
          revisionIds: revisions.map((revision) => revision.id),
        };
      });
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      const concurrent = await this.prisma.bookDeletionRequest.findUnique({ where: { bookId } });
      if (!concurrent) throw err;
      this.assertOwned(concurrent, hash);
      return this.toDto(concurrent);
    }

    await this.queue.removeBookWorkIfSafe(result.runIds, result.revisionIds);
    return this.toDto(result.request);
  }

  async getStatus(userId: string, requestId: string): Promise<BookDeletionRequestDto> {
    const request = await this.prisma.bookDeletionRequest.findUnique({ where: { id: requestId } });
    if (!request || request.ownerHash !== ownerHash(userId)) {
      throw new NotFoundException('Deletion request not found');
    }
    return this.toDto(request);
  }

  async process(requestId: string): Promise<void> {
    const claimed = await this.prisma.bookDeletionRequest.updateMany({
      where: {
        id: requestId,
        status: {
          in: [
            BookDeletionStatus.requested,
            BookDeletionStatus.retry_pending,
            BookDeletionStatus.processing,
          ],
        },
      },
      data: {
        status: BookDeletionStatus.processing,
        startedAt: new Date(),
        attemptCount: { increment: 1 },
        lastErrorCode: null,
      },
    });
    const request = await this.prisma.bookDeletionRequest.findUnique({ where: { id: requestId } });
    if (!request || request.status === BookDeletionStatus.completed) return;
    if (claimed.count === 0) return;

    try {
      if (await this.queue.hasActiveBookWork(request.bookId, request.id)) {
        throw new BookDeletionRetryableError('BOOK_WORK_STILL_ACTIVE');
      }

      const [images, pdfs] = await Promise.all([
        this.imageStorage.deleteBookArtifacts(request.bookId),
        this.pdfStorage.deleteBookArtifacts(request.bookId),
      ]);
      const deletedCount = images.deletedCount + pdfs.deletedCount;
      const remainingCount = images.remainingCount + pdfs.remainingCount;
      if (!images.complete || !pdfs.complete) {
        const code =
          images.errorCode === 'ARTIFACT_LIST_FAILED' || pdfs.errorCode === 'ARTIFACT_LIST_FAILED'
            ? 'ARTIFACT_LIST_FAILED'
            : 'ARTIFACT_DELETE_FAILED';
        throw new BookDeletionRetryableError(code, deletedCount, remainingCount);
      }

      await this.prisma.$transaction(async (tx) => {
        const activeRuns = await tx.generationRun.count({
          where: {
            bookId: request.bookId,
            status: { in: [GenerationRunStatus.queued, GenerationRunStatus.running] },
          },
        });
        const activeRevisions = await tx.pageImageRevision.count({
          where: {
            bookId: request.bookId,
            status: {
              in: [PageImageRevisionStatus.queued, PageImageRevisionStatus.running],
            },
          },
        });
        if (activeRuns > 0 || activeRevisions > 0) {
          throw new BookDeletionRetryableError('DATABASE_FINALIZATION_BLOCKED');
        }

        const aggregates = await Promise.all([
          tx.generationRun.findMany({ where: { bookId: request.bookId }, select: { id: true } }),
          tx.pageImageRevision.findMany({
            where: { bookId: request.bookId },
            select: { id: true },
          }),
        ]);
        const aggregateIds = [
          request.id,
          ...aggregates[0].map((row) => row.id),
          ...aggregates[1].map((row) => row.id),
        ];
        await tx.outboxEvent.deleteMany({ where: { aggregateId: { in: aggregateIds } } });

        const series = await tx.bookSeries.findMany({
          where: { bookIds: { has: request.bookId } },
          select: { id: true, bookIds: true },
        });
        for (const item of series) {
          await tx.bookSeries.update({
            where: { id: item.id },
            data: { bookIds: item.bookIds.filter((id) => id !== request.bookId) },
          });
        }

        const currentBook = await tx.book.findUnique({
          where: { id: request.bookId },
          select: {
            deletedAt: true,
            activeRunId: true,
            activePageImageRevisionId: true,
          },
        });
        if (
          currentBook &&
          (!currentBook.deletedAt ||
            currentBook.activeRunId !== null ||
            currentBook.activePageImageRevisionId !== null)
        ) {
          throw new BookDeletionRetryableError('DATABASE_FINALIZATION_BLOCKED');
        }
        if (currentBook) {
          const deletedBook = await tx.book.deleteMany({
            where: {
              id: request.bookId,
              deletedAt: { not: null },
              activeRunId: null,
              activePageImageRevisionId: null,
            },
          });
          if (deletedBook.count !== 1) {
            throw new BookDeletionRetryableError('DATABASE_FINALIZATION_BLOCKED');
          }
        }
        await tx.bookDeletionRequest.update({
          where: { id: request.id },
          data: {
            status: BookDeletionStatus.completed,
            completedAt: new Date(),
            deletedArtifactCount: { increment: deletedCount },
            remainingArtifactCount: 0,
            lastErrorCode: null,
          },
        });
      });
      this.logger.log(
        `book_hard_delete_completed deletionRequestId=${request.id} bookId=${request.bookId} deletedArtifactCount=${deletedCount}`,
      );
    } catch (err) {
      if (err instanceof BookDeletionRetryableError) {
        await this.recordRetry(request.id, err.code, err.deletedCount, err.remainingCount);
        throw err;
      }
      await this.recordRetry(request.id, 'UNEXPECTED_WORKFLOW_FAILURE', 0, 0);
      throw new BookDeletionRetryableError('UNEXPECTED_WORKFLOW_FAILURE');
    }
  }

  private async reschedule(request: BookDeletionRequest): Promise<BookDeletionRequest> {
    return this.prisma.$transaction(async (tx) => {
      const changed = await tx.bookDeletionRequest.updateMany({
        where: { id: request.id, status: BookDeletionStatus.retry_pending },
        data: { status: BookDeletionStatus.requested, lastErrorCode: null },
      });
      const updated = await tx.bookDeletionRequest.findUniqueOrThrow({
        where: { id: request.id },
      });
      if (changed.count === 0) return updated;
      const requestId = getRequestId();
      await tx.outboxEvent.create({
        data: {
          aggregateType: 'book_deletion',
          aggregateId: request.id,
          eventType: 'book_deletion_retried',
          payload: {
            bookId: request.bookId,
            deletionRequestId: request.id,
            ...(requestId && { requestId }),
          } as unknown as Prisma.InputJsonValue,
        },
      });
      return updated;
    });
  }

  private async recordRetry(
    requestId: string,
    code: RetryCode,
    deletedCount: number,
    remainingCount: number,
  ): Promise<void> {
    await this.prisma.bookDeletionRequest.updateMany({
      where: { id: requestId, status: BookDeletionStatus.processing },
      data: {
        status: BookDeletionStatus.retry_pending,
        lastErrorCode: code,
        ...(deletedCount > 0 && { deletedArtifactCount: { increment: deletedCount } }),
        remainingArtifactCount: remainingCount,
      },
    });
    this.logger.warn(
      `book_hard_delete_retry_pending deletionRequestId=${requestId} errorCode=${code} remainingArtifactCount=${remainingCount}`,
    );
  }

  private assertOwned(request: BookDeletionRequest, hash: string): void {
    if (request.ownerHash !== hash) throw new NotFoundException('Book not found');
  }

  private toDto(request: BookDeletionRequest): BookDeletionRequestDto {
    return {
      id: request.id,
      bookId: request.bookId,
      status: request.status,
      attemptCount: request.attemptCount,
      deletedArtifactCount: request.deletedArtifactCount,
      remainingArtifactCount: request.remainingArtifactCount,
      lastErrorCode: request.lastErrorCode,
      requestedAt: request.requestedAt.toISOString(),
      completedAt: request.completedAt?.toISOString() ?? null,
    };
  }
}
