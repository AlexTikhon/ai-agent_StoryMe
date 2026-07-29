import {
  BookDeletionStatus,
  GenerationRunStatus,
  PageImageRevisionStatus,
  UserRole,
  type BookDeletionRequest,
} from '@prisma/client';
import { createHash } from 'node:crypto';
import { NotFoundException } from '@nestjs/common';
import { createMockPrisma } from '../common/test-utils/mock-prisma';
import { BookDeletionRetryableError, BookHardDeletionService } from './book-hard-deletion.service';

const BOOK_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';
const REQUEST_ID = '33333333-3333-4333-8333-333333333333';

function hashOwner(userId = USER_ID): string {
  return createHash('sha256').update(`storyme:book-deletion-owner:v1:${userId}`).digest('hex');
}

function deletion(overrides: Partial<BookDeletionRequest> = {}): BookDeletionRequest {
  return {
    id: REQUEST_ID,
    bookId: BOOK_ID,
    ownerHash: hashOwner(),
    requestedByRole: UserRole.user,
    status: BookDeletionStatus.requested,
    privateDataRetentionDays: 30,
    generatedArtifactRetentionDays: 30,
    attemptCount: 0,
    deletedArtifactCount: 0,
    remainingArtifactCount: 0,
    lastErrorCode: null,
    requestedAt: new Date('2026-07-28T12:00:00.000Z'),
    startedAt: null,
    completedAt: null,
    updatedAt: new Date('2026-07-28T12:00:00.000Z'),
    ...overrides,
  };
}

function harness() {
  const prisma = createMockPrisma();
  prisma.$transaction.mockImplementation(async (callback: (tx: typeof prisma) => unknown) =>
    callback(prisma),
  );
  const credits = { addInTransaction: vi.fn() };
  const queue = {
    removeBookWorkIfSafe: vi.fn(),
    hasActiveBookWork: vi.fn().mockResolvedValue(false),
  };
  const imageStorage = {
    deleteBookArtifacts: vi.fn().mockResolvedValue({
      complete: true,
      deletedCount: 2,
      remainingCount: 0,
      failureCount: 0,
      errorCode: null,
    }),
  };
  const pdfStorage = {
    deleteBookArtifacts: vi.fn().mockResolvedValue({
      complete: true,
      deletedCount: 1,
      remainingCount: 0,
      failureCount: 0,
      errorCode: null,
    }),
  };
  const service = new BookHardDeletionService(
    prisma as never,
    credits as never,
    queue as never,
    imageStorage as never,
    pdfStorage as never,
  );
  return { service, prisma, credits, queue, imageStorage, pdfStorage };
}

describe('BookHardDeletionService', () => {
  it('requires ownership without exposing whether another user has a request', async () => {
    const h = harness();
    h.prisma.bookDeletionRequest.findUnique.mockResolvedValue(
      deletion({ ownerHash: hashOwner('another-user') }),
    );

    await expect(
      h.service.request(USER_ID, UserRole.user, BOOK_ID, BOOK_ID),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(h.prisma.$transaction).not.toHaveBeenCalled();
  });

  it('is idempotent when the same owner repeats an existing request', async () => {
    const h = harness();
    h.prisma.bookDeletionRequest.findUnique.mockResolvedValue(deletion());

    const first = await h.service.request(USER_ID, UserRole.user, BOOK_ID, BOOK_ID);
    const second = await h.service.request(USER_ID, UserRole.user, BOOK_ID, BOOK_ID);

    expect(first).toEqual(second);
    expect(h.prisma.$transaction).not.toHaveBeenCalled();
    expect(h.queue.removeBookWorkIfSafe).not.toHaveBeenCalled();
  });

  it('atomically hides the book, fences both active work types, and emits a private-data-free outbox event', async () => {
    const h = harness();
    const request = deletion();
    h.prisma.bookDeletionRequest.findUnique.mockResolvedValue(null);
    h.prisma.book.findFirst.mockResolvedValue({
      id: BOOK_ID,
      userId: USER_ID,
      deletedAt: null,
    } as never);
    h.prisma.generationRun.findMany.mockResolvedValue([
      { id: 'run-1', status: GenerationRunStatus.running },
    ] as never);
    h.prisma.pageImageRevision.findMany.mockResolvedValue([
      { id: 'revision-1', status: PageImageRevisionStatus.queued },
    ] as never);
    h.prisma.creditTransaction.findUnique.mockResolvedValue(null);
    h.prisma.bookDeletionRequest.create.mockResolvedValue(request);

    await h.service.request(USER_ID, UserRole.user, BOOK_ID, BOOK_ID);

    expect(h.prisma.book.update).toHaveBeenCalledWith({
      where: { id: BOOK_ID },
      data: {
        deletedAt: expect.any(Date),
        activeRunId: null,
        activePageImageRevisionId: null,
      },
    });
    expect(h.prisma.generationRun.updateMany).toHaveBeenCalledWith({
      where: {
        id: { in: ['run-1'] },
        status: { in: [GenerationRunStatus.queued, GenerationRunStatus.running] },
      },
      data: {
        status: GenerationRunStatus.cancelled,
        cancelledAt: expect.any(Date),
        fencingVersion: { increment: 1 },
      },
    });
    expect(h.prisma.pageImageRevision.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: PageImageRevisionStatus.failed,
          fencingVersion: { increment: 1 },
        }),
      }),
    );
    expect(h.prisma.outboxEvent.create).toHaveBeenCalledWith({
      data: {
        aggregateType: 'book_deletion',
        aggregateId: REQUEST_ID,
        eventType: 'book_deletion_requested',
        payload: { bookId: BOOK_ID, deletionRequestId: REQUEST_ID },
      },
    });
    expect(JSON.stringify(h.prisma.outboxEvent.create.mock.calls)).not.toMatch(
      /prompt|story|photo|token|credential|password/i,
    );
    expect(h.queue.removeBookWorkIfSafe).toHaveBeenCalledWith(['run-1'], ['revision-1']);
  });

  it('keeps the database graph and records a retriable partial storage failure', async () => {
    const h = harness();
    h.prisma.bookDeletionRequest.updateMany.mockResolvedValue({ count: 1 });
    h.prisma.bookDeletionRequest.findUnique.mockResolvedValue(
      deletion({ status: BookDeletionStatus.processing }),
    );
    h.imageStorage.deleteBookArtifacts.mockResolvedValue({
      complete: false,
      deletedCount: 1,
      remainingCount: 2,
      failureCount: 1,
      errorCode: 'ARTIFACT_DELETE_FAILED',
    });

    await expect(h.service.process(REQUEST_ID)).rejects.toEqual(
      expect.objectContaining<BookDeletionRetryableError>({
        code: 'ARTIFACT_DELETE_FAILED',
      }),
    );

    expect(h.prisma.book.deleteMany).not.toHaveBeenCalled();
    expect(h.prisma.bookDeletionRequest.updateMany).toHaveBeenLastCalledWith({
      where: { id: REQUEST_ID, status: BookDeletionStatus.processing },
      data: {
        status: BookDeletionStatus.retry_pending,
        lastErrorCode: 'ARTIFACT_DELETE_FAILED',
        deletedArtifactCount: { increment: 2 },
        remainingArtifactCount: 2,
      },
    });
  });

  it('finalizes only after both storage drivers are verified empty', async () => {
    const h = harness();
    h.prisma.bookDeletionRequest.updateMany.mockResolvedValue({ count: 1 });
    h.prisma.bookDeletionRequest.findUnique.mockResolvedValue(
      deletion({ status: BookDeletionStatus.processing }),
    );
    h.prisma.generationRun.count.mockResolvedValue(0);
    h.prisma.pageImageRevision.count.mockResolvedValue(0);
    h.prisma.generationRun.findMany.mockResolvedValue([{ id: 'run-1' }] as never);
    h.prisma.pageImageRevision.findMany.mockResolvedValue([{ id: 'revision-1' }] as never);
    h.prisma.bookSeries.findMany.mockResolvedValue([]);
    h.prisma.book.findUnique.mockResolvedValue({
      deletedAt: new Date(),
      activeRunId: null,
      activePageImageRevisionId: null,
    } as never);
    h.prisma.book.deleteMany.mockResolvedValue({ count: 1 });

    await h.service.process(REQUEST_ID);

    expect(h.imageStorage.deleteBookArtifacts).toHaveBeenCalledWith(BOOK_ID);
    expect(h.pdfStorage.deleteBookArtifacts).toHaveBeenCalledWith(BOOK_ID);
    expect(h.prisma.book.deleteMany).toHaveBeenCalledWith({
      where: {
        id: BOOK_ID,
        deletedAt: { not: null },
        activeRunId: null,
        activePageImageRevisionId: null,
      },
    });
    expect(h.prisma.bookDeletionRequest.update).toHaveBeenCalledWith({
      where: { id: REQUEST_ID },
      data: {
        status: BookDeletionStatus.completed,
        completedAt: expect.any(Date),
        deletedArtifactCount: { increment: 3 },
        remainingArtifactCount: 0,
        lastErrorCode: null,
      },
    });
  });

  it('does not report completion when the guarded database delete removes no book row', async () => {
    const h = harness();
    h.prisma.bookDeletionRequest.updateMany.mockResolvedValue({ count: 1 });
    h.prisma.bookDeletionRequest.findUnique.mockResolvedValue(
      deletion({ status: BookDeletionStatus.processing }),
    );
    h.prisma.generationRun.count.mockResolvedValue(0);
    h.prisma.pageImageRevision.count.mockResolvedValue(0);
    h.prisma.generationRun.findMany.mockResolvedValue([]);
    h.prisma.pageImageRevision.findMany.mockResolvedValue([]);
    h.prisma.bookSeries.findMany.mockResolvedValue([]);
    h.prisma.book.findUnique.mockResolvedValue({
      deletedAt: new Date(),
      activeRunId: null,
      activePageImageRevisionId: null,
    } as never);
    h.prisma.book.deleteMany.mockResolvedValue({ count: 0 });

    await expect(h.service.process(REQUEST_ID)).rejects.toEqual(
      expect.objectContaining<BookDeletionRetryableError>({
        code: 'DATABASE_FINALIZATION_BLOCKED',
      }),
    );

    expect(h.prisma.bookDeletionRequest.update).not.toHaveBeenCalled();
    expect(h.prisma.bookDeletionRequest.updateMany).toHaveBeenLastCalledWith({
      where: { id: REQUEST_ID, status: BookDeletionStatus.processing },
      data: {
        status: BookDeletionStatus.retry_pending,
        lastErrorCode: 'DATABASE_FINALIZATION_BLOCKED',
        remainingArtifactCount: 0,
      },
    });
  });
});
