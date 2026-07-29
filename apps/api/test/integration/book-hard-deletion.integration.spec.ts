import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  BookDeletionStatus,
  GenerationRunStatus,
  PageImageRevisionStatus,
  UserRole,
} from '@prisma/client';
import { PrismaService } from '../../src/database/prisma.service';
import { CreditsService } from '../../src/credits/credits.service';
import {
  BookDeletionRetryableError,
  BookHardDeletionService,
} from '../../src/books/book-hard-deletion.service';

describe('Book hard deletion (Slice 6C, real Postgres)', () => {
  const prisma = new PrismaService();
  const credits = new CreditsService(prisma);
  const userIds: string[] = [];
  const deletionRequestIds: string[] = [];

  const queue = {
    removeBookWorkIfSafe: vi.fn().mockResolvedValue(undefined),
    hasActiveBookWork: vi.fn().mockResolvedValue(false),
  };
  const imageStorage = {
    deleteBookArtifacts: vi.fn(),
  };
  const pdfStorage = {
    deleteBookArtifacts: vi.fn(),
  };
  const service = new BookHardDeletionService(
    prisma,
    credits,
    queue as never,
    imageStorage as never,
    pdfStorage as never,
  );

  beforeAll(async () => {
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  afterEach(async () => {
    if (deletionRequestIds.length > 0) {
      await prisma.outboxEvent.deleteMany({
        where: { aggregateId: { in: deletionRequestIds } },
      });
      await prisma.bookDeletionRequest.deleteMany({
        where: { id: { in: deletionRequestIds } },
      });
      deletionRequestIds.length = 0;
    }
    if (userIds.length > 0) {
      await prisma.creditTransaction.deleteMany({ where: { userId: { in: userIds } } });
      await prisma.user.deleteMany({ where: { id: { in: userIds } } });
      userIds.length = 0;
    }
    vi.clearAllMocks();
  });

  it('fences active work, retries partial storage deletion, then atomically removes private rows', async () => {
    const user = await prisma.user.create({
      data: { email: `hard-delete-${randomUUID()}@example.test`, emailVerified: true },
    });
    userIds.push(user.id);
    const book = await prisma.book.create({
      data: {
        userId: user.id,
        status: 'char_build',
        childName: 'Private child name',
        childAge: 7,
        theme: 'private theme',
        storyPlan: { privateStory: 'must be removed' },
      },
    });
    const run = await prisma.generationRun.create({
      data: {
        bookId: book.id,
        userId: user.id,
        kind: 'initial',
        status: GenerationRunStatus.running,
        inputSnapshot: { childName: 'Private child name' },
        inputHash: 'private-input-hash',
        fencingVersion: 4,
        deliveryToken: 'old-worker-token',
      },
    });
    const revision = await prisma.pageImageRevision.create({
      data: {
        bookId: book.id,
        userId: user.id,
        pageNumber: 1,
        expectedPageVersion: 1,
        status: PageImageRevisionStatus.running,
        costCredits: 1,
        provider: 'mock',
        quoteExpiresAt: new Date(Date.now() + 60_000),
        sourceBookUpdatedAt: book.updatedAt,
        fencingVersion: 2,
        deliveryToken: 'old-revision-token',
      },
    });
    await prisma.book.update({
      where: { id: book.id },
      data: {
        activeRunId: run.id,
        activePageImageRevisionId: revision.id,
      },
    });

    const requested = await service.request(user.id, UserRole.user, book.id, book.id);
    deletionRequestIds.push(requested.id);
    const repeated = await service.request(user.id, UserRole.user, book.id, book.id);
    expect(repeated.id).toBe(requested.id);

    const [fencedBook, fencedRun, fencedRevision] = await Promise.all([
      prisma.book.findUniqueOrThrow({ where: { id: book.id } }),
      prisma.generationRun.findUniqueOrThrow({ where: { id: run.id } }),
      prisma.pageImageRevision.findUniqueOrThrow({ where: { id: revision.id } }),
    ]);
    expect(fencedBook.deletedAt).not.toBeNull();
    expect(fencedBook.activeRunId).toBeNull();
    expect(fencedBook.activePageImageRevisionId).toBeNull();
    expect(fencedRun).toMatchObject({
      status: GenerationRunStatus.cancelled,
      fencingVersion: 5,
    });
    expect(fencedRevision).toMatchObject({
      status: PageImageRevisionStatus.failed,
      fencingVersion: 3,
    });

    imageStorage.deleteBookArtifacts.mockResolvedValueOnce({
      complete: false,
      deletedCount: 1,
      remainingCount: 1,
      failureCount: 1,
      errorCode: 'ARTIFACT_DELETE_FAILED',
    });
    pdfStorage.deleteBookArtifacts.mockResolvedValue({
      complete: true,
      deletedCount: 1,
      remainingCount: 0,
      failureCount: 0,
      errorCode: null,
    });
    await expect(service.process(requested.id)).rejects.toBeInstanceOf(BookDeletionRetryableError);
    expect(await prisma.book.findUnique({ where: { id: book.id } })).not.toBeNull();
    expect(
      await prisma.bookDeletionRequest.findUniqueOrThrow({ where: { id: requested.id } }),
    ).toMatchObject({
      status: BookDeletionStatus.retry_pending,
      remainingArtifactCount: 1,
      lastErrorCode: 'ARTIFACT_DELETE_FAILED',
    });

    await service.request(user.id, UserRole.user, book.id, book.id);
    imageStorage.deleteBookArtifacts.mockResolvedValueOnce({
      complete: true,
      deletedCount: 1,
      remainingCount: 0,
      failureCount: 0,
      errorCode: null,
    });
    await service.process(requested.id);

    expect(await prisma.book.findUnique({ where: { id: book.id } })).toBeNull();
    expect(await prisma.generationRun.findUnique({ where: { id: run.id } })).toBeNull();
    expect(await prisma.pageImageRevision.findUnique({ where: { id: revision.id } })).toBeNull();
    const audit = await prisma.bookDeletionRequest.findUniqueOrThrow({
      where: { id: requested.id },
    });
    expect(audit).toMatchObject({
      status: BookDeletionStatus.completed,
      remainingArtifactCount: 0,
      lastErrorCode: null,
    });
    expect(JSON.stringify(audit)).not.toContain('Private child name');
    expect(JSON.stringify(audit)).not.toContain('private theme');
    expect(JSON.stringify(audit)).not.toContain('must be removed');
    expect(JSON.stringify(audit)).not.toContain(user.email);
  });
});
