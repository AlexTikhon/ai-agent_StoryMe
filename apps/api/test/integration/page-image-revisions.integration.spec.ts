import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { PageImageRevisionStatus } from '@prisma/client';
import { PrismaService } from '../../src/database/prisma.service';

describe('Page image revision constraints (real Postgres)', () => {
  const prisma = new PrismaService();
  const userIds: string[] = [];

  beforeAll(async () => {
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  afterEach(async () => {
    if (userIds.length > 0) {
      await prisma.user.deleteMany({ where: { id: { in: userIds } } });
      userIds.length = 0;
    }
  });

  async function createBook() {
    const user = await prisma.user.create({
      data: { email: `phase-4b-${randomUUID()}@example.test` },
    });
    userIds.push(user.id);
    const book = await prisma.book.create({
      data: { userId: user.id, status: 'complete' },
    });
    await prisma.bookPage.create({
      data: { bookId: book.id, pageNumber: 1, version: 1 },
    });
    return { user, book };
  }

  function revisionData(
    userId: string,
    bookId: string,
    sourceBookUpdatedAt: Date,
    status: PageImageRevisionStatus,
  ) {
    return {
      userId,
      bookId,
      pageNumber: 1,
      expectedPageVersion: 1,
      status,
      costCredits: 1,
      provider: 'mock',
      quoteExpiresAt: new Date(Date.now() + 60_000),
      sourceBookUpdatedAt,
    };
  }

  it('persists the quoted -> queued -> running -> completed lifecycle', async () => {
    const { user, book } = await createBook();
    const revision = await prisma.pageImageRevision.create({
      data: revisionData(user.id, book.id, book.updatedAt, PageImageRevisionStatus.quoted),
    });

    for (const status of [
      PageImageRevisionStatus.queued,
      PageImageRevisionStatus.running,
      PageImageRevisionStatus.completed,
    ]) {
      const updated = await prisma.pageImageRevision.update({
        where: { id: revision.id },
        data: { status },
      });
      expect(updated.status).toBe(status);
    }
  });

  it('allows only one queued or running revision per book', async () => {
    const { user, book } = await createBook();
    await prisma.pageImageRevision.create({
      data: revisionData(user.id, book.id, book.updatedAt, PageImageRevisionStatus.queued),
    });

    await expect(
      prisma.pageImageRevision.create({
        data: revisionData(user.id, book.id, book.updatedAt, PageImageRevisionStatus.running),
      }),
    ).rejects.toThrow();
  });

  it('allows multiple unconfirmed quotes but rejects non-positive cost and version values', async () => {
    const { user, book } = await createBook();
    await prisma.pageImageRevision.create({
      data: revisionData(user.id, book.id, book.updatedAt, PageImageRevisionStatus.quoted),
    });
    await expect(
      prisma.pageImageRevision.create({
        data: revisionData(user.id, book.id, book.updatedAt, PageImageRevisionStatus.quoted),
      }),
    ).resolves.toBeDefined();

    await expect(
      prisma.pageImageRevision.create({
        data: {
          ...revisionData(user.id, book.id, book.updatedAt, PageImageRevisionStatus.quoted),
          costCredits: 0,
        },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.pageImageRevision.create({
        data: {
          ...revisionData(user.id, book.id, book.updatedAt, PageImageRevisionStatus.quoted),
          expectedPageVersion: 0,
        },
      }),
    ).rejects.toThrow();
  });
});
