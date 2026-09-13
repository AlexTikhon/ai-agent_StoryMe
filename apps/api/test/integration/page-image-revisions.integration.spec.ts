import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { PageImageRevisionStatus } from '@prisma/client';
import { PrismaService } from '../../src/database/prisma.service';
import {
  CreditsService,
  pageImageRevisionChargeIdempotencyKey,
  pageImageRevisionRefundIdempotencyKey,
} from '../../src/credits/credits.service';
import { BookPageImageRevisionService } from '../../src/books/book-page-image-revision.service';
import { PageImageRevisionExecutionGateway } from '../../src/books/page-image-revision-execution.gateway';
import { LocalImageAssetStorage, claimImageAssetKey } from '../../src/images/image-asset-storage';
import { LocalPdfStorage } from '../../src/pdf/pdf-storage';
import { MockImageGenerationProvider } from '../../src/images/image-generation-provider';
import { MockStoryGenerationProvider } from '../../src/agent/story-generation-provider';
import { MockCharacterProfileProvider } from '../../src/agent/character-profile-provider';
import { claimNamespace } from '../../src/agent/generation-artifact-namespace';
import { Prisma } from '@prisma/client';

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
      await prisma.creditTransaction.deleteMany({ where: { userId: { in: userIds } } });
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

  it('allows zero-credit home quotes and rejects negative cost or non-positive versions', async () => {
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
    ).resolves.toBeDefined();

    await expect(
      prisma.pageImageRevision.create({
        data: {
          ...revisionData(user.id, book.id, book.updatedAt, PageImageRevisionStatus.quoted),
          costCredits: -1,
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

  it('releases the active pointer and refunds the original charge exactly once under concurrent finalization', async () => {
    const { user, book } = await createBook();
    const revision = await prisma.pageImageRevision.create({
      data: revisionData(user.id, book.id, book.updatedAt, PageImageRevisionStatus.running),
    });
    await prisma.book.update({
      where: { id: book.id },
      data: { activePageImageRevisionId: revision.id },
    });
    await prisma.creditTransaction.create({
      data: {
        userId: user.id,
        bookId: book.id,
        amount: -1,
        balanceAfter: 0,
        reason: 'regen_page',
        idempotencyKey: pageImageRevisionChargeIdempotencyKey(revision.id),
      },
    });
    const service = new BookPageImageRevisionService(
      {} as never,
      prisma,
      new PageImageRevisionExecutionGateway(prisma),
      new CreditsService(prisma),
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );

    await Promise.all([
      service.failAndRefund(
        revision.id,
        'PAGE_IMAGE_STORAGE_FAILURE',
        'safe',
        0,
        'storage_failure',
      ),
      service.failAndRefund(
        revision.id,
        'PAGE_IMAGE_STORAGE_FAILURE',
        'safe',
        0,
        'storage_failure',
      ),
    ]);

    const [finalRevision, finalBook, refunds] = await Promise.all([
      prisma.pageImageRevision.findUniqueOrThrow({ where: { id: revision.id } }),
      prisma.book.findUniqueOrThrow({ where: { id: book.id } }),
      prisma.creditTransaction.findMany({
        where: { idempotencyKey: pageImageRevisionRefundIdempotencyKey(revision.id) },
      }),
    ]);
    expect(finalRevision).toMatchObject({ status: 'failed', failureReason: 'storage_failure' });
    expect(finalBook.activePageImageRevisionId).toBeNull();
    expect(refunds).toHaveLength(1);
    expect(refunds[0]?.amount).toBe(1);
  });

  it('recovers after a real process crash after image storage and before publication', async () => {
    const { user, book } = await createBook();
    const storage = new LocalImageAssetStorage();
    const pdfStorage = new LocalPdfStorage();
    const imageProvider = new MockImageGenerationProvider();
    const publishedRunId = randomUUID();
    const publishedFence = 1;
    const characterProfile = await new MockCharacterProfileProvider().buildProfile({
      bookId: book.id,
      childName: 'Mia',
      childAge: 6,
      theme: 'friendship',
      language: 'en',
    });
    const story = await new MockStoryGenerationProvider().generateStory({
      bookId: book.id,
      childName: 'Mia',
      childAge: 6,
      theme: 'friendship',
      language: 'en',
      pageCount: 6,
      characterProfile,
    });
    const sourceNamespace = claimNamespace(publishedRunId, publishedFence);
    for (const entry of story.imageGenerationResult.images) {
      const output = await imageProvider.generateImage({
        bookId: book.id,
        entry,
        characterCard: story.characterCard,
      });
      await storage.saveImageAsset(
        claimImageAssetKey(book.id, sourceNamespace, entry.kind, entry.pageNumber),
        output.buffer,
        output.contentType,
      );
    }
    const published = await prisma.book.update({
      where: { id: book.id },
      data: {
        childName: 'Mia',
        childAge: 6,
        language: 'en',
        theme: 'friendship',
        pageCount: 6,
        bookPreview: story.bookPreview as unknown as Prisma.InputJsonValue,
        imageGenerationResult: story.imageGenerationResult as unknown as Prisma.InputJsonValue,
        characterCard: story.characterCard as unknown as Prisma.InputJsonValue,
        publishedRunId,
        publishedRunFencingVersion: publishedFence,
      },
    });
    const revision = await prisma.pageImageRevision.create({
      data: {
        userId: user.id,
        bookId: book.id,
        pageNumber: 1,
        expectedPageVersion: 1,
        status: 'queued',
        costCredits: 0,
        provider: 'mock',
        authorizedDispatches: 1,
        quoteExpiresAt: new Date(Date.now() + 60_000),
        queueExpiresAt: new Date(Date.now() + 60_000),
        sourceBookUpdatedAt: published.updatedAt,
        sourcePublishedRunId: publishedRunId,
        sourcePublishedRunFencingVersion: publishedFence,
      },
    });
    const reserved = await prisma.book.update({
      where: { id: book.id },
      data: { activePageImageRevisionId: revision.id },
    });
    await prisma.pageImageRevision.update({
      where: { id: revision.id },
      data: { sourceBookUpdatedAt: reserved.updatedAt },
    });

    try {
      const exitCode = await new Promise<number | null>((resolve, reject) => {
        const child = spawn(
          process.execPath,
          [
            '-r',
            'ts-node/register/transpile-only',
            '-r',
            'tsconfig-paths/register',
            'test/integration/fixtures/terminated-page-revision-worker.ts',
            revision.id,
          ],
          {
            env: { ...process.env, TS_NODE_PROJECT: 'tsconfig.scripts.json' },
            stdio: 'ignore',
          },
        );
        child.once('error', reject);
        child.once('exit', resolve);
      });
      expect(exitCode).toBe(86);
      const crashed = await prisma.pageImageRevision.findUniqueOrThrow({
        where: { id: revision.id },
      });
      expect(crashed).toMatchObject({
        status: 'running',
        providerDispatches: 1,
        providerOutcome: 'response_received',
      });
      expect(crashed.candidateImageKey).toBeTruthy();
      expect(await storage.getImageAsset(crashed.candidateImageKey!)).toBeTruthy();

      await prisma.pageImageRevision.update({
        where: { id: revision.id },
        data: { leaseExpiresAt: new Date(Date.now() - 1) },
      });
      const service = new BookPageImageRevisionService(
        {} as never,
        prisma,
        new PageImageRevisionExecutionGateway(prisma),
        new CreditsService(prisma),
        imageProvider,
        storage,
        pdfStorage,
        { get: () => 'home' } as never,
      );
      const takeover = await service.claim(revision.id, 'recovery-delivery');
      expect(takeover).toBeTruthy();
      await service.executeClaimed(revision.id, takeover!.fencingVersion);

      const [recovered, recoveredBook] = await Promise.all([
        prisma.pageImageRevision.findUniqueOrThrow({ where: { id: revision.id } }),
        prisma.book.findUniqueOrThrow({ where: { id: book.id } }),
      ]);
      expect(recovered).toMatchObject({
        status: 'completed',
        providerDispatches: 1,
        checkpointState: 'artifact_stored',
      });
      expect(recoveredBook.activePageImageRevisionId).toBeNull();
      expect(recoveredBook.publishedPdfRunId).toBe(revision.id);
    } finally {
      await storage.deleteBookArtifacts(book.id);
      await pdfStorage.deleteBookArtifacts(book.id);
    }
  }, 30_000);
});
