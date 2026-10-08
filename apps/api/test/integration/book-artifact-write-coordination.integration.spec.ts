import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ConflictException } from '@nestjs/common';
import {
  BookArtifactWriteState,
  BookDeletionStatus,
  BookStatus,
  UserRole,
  type Book,
} from '@prisma/client';
import type { BookPreview, ImageGenerationResult } from '@book/types';
import { PrismaService } from '../../src/database/prisma.service';
import { CreditsService } from '../../src/credits/credits.service';
import { BookCrudService } from '../../src/books/book-crud.service';
import { BookAssetService } from '../../src/books/book-asset.service';
import { BookPageChangeService } from '../../src/books/book-page-change.service';
import {
  BookDeletionRetryableError,
  BookHardDeletionService,
} from '../../src/books/book-hard-deletion.service';
import { publishedImageKey } from '../../src/books/published-page-image-key';
import { resolvePublishedImageNamespace } from '../../src/agent/generation-artifact-namespace';
import {
  CloudImageAssetStorage,
  LocalImageAssetStorage,
  childPhotoAssetKey,
  type ImageAssetStorage,
} from '../../src/images/image-asset-storage';
import { CloudPdfStorage, LocalPdfStorage, type PdfStorage } from '../../src/pdf/pdf-storage';
import { generateMockImagePng } from '../../src/images/mock-image-producer';
import { BookArtifactWriteCoordinator } from '../../src/storage/book-artifact-write-coordinator';
import { GenerationRunRecoveryService } from '../../src/agent/generation-run-recovery.service';

vi.mock('../../src/pdf/pdf-renderer', () => ({
  renderStorybookPdf: vi.fn().mockResolvedValue(Buffer.from('%PDF-regression-candidate')),
}));

// ───────────────────────── barrier + storage helpers ─────────────────────────

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** In-memory S3: the only "cloud" in these tests. It never touches a network. */
class FakeS3 {
  readonly objects = new Map<string, Buffer>();
  /** Keys DeleteObjects reports as per-object errors (partial failure). */
  failDeleteKeys = new Set<string>();
  failList = false;

  async send(command: { constructor: { name: string }; input: Record<string, any> }) {
    const input = command.input;
    switch (command.constructor.name) {
      case 'PutObjectCommand':
        this.objects.set(input['Key'], Buffer.from(input['Body']));
        return {};
      case 'GetObjectCommand': {
        const body = this.objects.get(input['Key']);
        if (!body) throw Object.assign(new Error('missing'), { name: 'NoSuchKey' });
        return { Body: { transformToByteArray: async () => new Uint8Array(body) } };
      }
      case 'HeadObjectCommand': {
        if (!this.objects.has(input['Key'])) {
          throw Object.assign(new Error('missing'), { name: 'NotFound' });
        }
        return { ContentType: 'image/png' };
      }
      case 'DeleteObjectCommand':
        this.objects.delete(input['Key']);
        return {};
      case 'DeleteObjectsCommand': {
        const errors: { Key: string }[] = [];
        for (const { Key } of input['Delete'].Objects as { Key: string }[]) {
          if (this.failDeleteKeys.has(Key)) errors.push({ Key });
          else this.objects.delete(Key);
        }
        return { Errors: errors };
      }
      case 'ListObjectsV2Command': {
        if (this.failList) throw new Error('list unavailable');
        const keys = [...this.objects.keys()].filter((key) => key.startsWith(input['Prefix']));
        return { Contents: keys.map((Key) => ({ Key })), IsTruncated: false };
      }
      default:
        throw new Error(`Unexpected S3 command ${command.constructor.name}`);
    }
  }
}

interface Hooks {
  /** Runs after admission, immediately before the bytes are written. */
  beforeSaveImage?: (key: string) => Promise<void>;
  /** Runs after a real read, before the bytes reach the caller. */
  afterGetImage?: (key: string) => Promise<void>;
  beforeSavePdf?: () => Promise<void>;
  failDeletes?: boolean;
}

function hooked<T extends object>(inner: T, overrides: Record<string, unknown>): T {
  return new Proxy(inner, {
    get(target, prop) {
      if (typeof prop === 'string' && prop in overrides) return overrides[prop];
      const value = (target as Record<string | symbol, unknown>)[prop];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

interface Driver {
  name: 'local' | 'cloud';
  inner: { image: ImageAssetStorage; pdf: PdfStorage };
  image: ImageAssetStorage;
  pdf: PdfStorage;
  hooks: Hooks;
  s3?: FakeS3;
  list(bookId: string): Promise<string[]>;
  dispose(): Promise<void>;
}

async function walk(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const nested = await Promise.all(
    entries.map((entry) =>
      entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)],
    ),
  );
  return nested.flat();
}

const CLOUD_CONFIG = {
  driver: 's3' as const,
  bucket: 'regression-bucket',
  region: 'us-east-1',
  accessKeyId: 'not-a-real-key',
  secretAccessKey: 'not-a-real-secret',
};

async function createDriver(name: 'local' | 'cloud'): Promise<Driver> {
  const hooks: Hooks = {};
  let image: ImageAssetStorage;
  let pdf: PdfStorage;
  let s3: FakeS3 | undefined;
  let root: string | undefined;
  if (name === 'local') {
    root = await mkdtemp(join(tmpdir(), 'storyme-artifact-writes-'));
    image = new LocalImageAssetStorage(root);
    pdf = new LocalPdfStorage(root);
  } else {
    s3 = new FakeS3();
    const cloudImage = new CloudImageAssetStorage(CLOUD_CONFIG);
    const cloudPdf = new CloudPdfStorage(CLOUD_CONFIG);
    (cloudImage as unknown as { client: FakeS3 }).client = s3;
    (cloudPdf as unknown as { client: FakeS3 }).client = s3;
    image = cloudImage;
    pdf = cloudPdf;
  }
  const hookedImage = hooked(image, {
    saveImageAsset: async (...args: Parameters<ImageAssetStorage['saveImageAsset']>) => {
      await hooks.beforeSaveImage?.(args[0]);
      return image.saveImageAsset(...args);
    },
    getImageAsset: async (key: string) => {
      const result = await image.getImageAsset(key);
      await hooks.afterGetImage?.(key);
      return result;
    },
    deleteImageAsset: async (key: string) => {
      if (hooks.failDeletes) throw new Error('storage delete unavailable');
      return image.deleteImageAsset(key);
    },
  });
  const hookedPdf = hooked(pdf, {
    saveClaimPreviewPdf: async (...args: Parameters<PdfStorage['saveClaimPreviewPdf']>) => {
      await hooks.beforeSavePdf?.();
      return pdf.saveClaimPreviewPdf(...args);
    },
    deleteClaimPreviewPdf: async (...args: Parameters<PdfStorage['deleteClaimPreviewPdf']>) => {
      if (hooks.failDeletes) throw new Error('storage delete unavailable');
      return pdf.deleteClaimPreviewPdf(...args);
    },
  });
  return {
    name,
    inner: { image, pdf },
    image: hookedImage,
    pdf: hookedPdf,
    hooks,
    ...(s3 && { s3 }),
    async list(bookId) {
      if (s3) return [...s3.objects.keys()].filter((key) => key.includes(bookId));
      return (await walk(root!)).filter((path) => path.includes(bookId));
    },
    async dispose() {
      if (root) await rm(root, { recursive: true, force: true });
    },
  };
}

// ───────────────────────────── fixtures ─────────────────────────────

const preview = (): BookPreview => ({
  title: 'A Small Adventure',
  subtitle: 'A story',
  cover: {
    title: 'A Small Adventure',
    subtitle: 'A story',
    childName: 'Mia',
    illustrationPrompt: 'cover',
  },
  pages: [
    {
      pageNumber: 1,
      title: 'Page one',
      text: 'Old text',
      illustrationPrompt: 'page one',
      layout: 'image_top_text_bottom',
      learningGoal: 'Kindness',
    },
  ],
  backCover: { message: 'The end', educationalSummary: 'Be kind' },
  metadata: { language: 'en', theme: 'forest', childAge: 6, totalPages: 1, generatedBy: 'mock' },
});

const imageResult = (bookId: string): ImageGenerationResult => ({
  provider: 'local_mock',
  status: 'complete',
  createdAt: '1970-01-01T00:00:00.000Z',
  images: (
    [
      ['cover', undefined],
      ['page', 1],
      ['back_cover', undefined],
    ] as const
  ).map(([kind, pageNumber], index) => ({
    id: `${bookId}-${kind === 'page' ? 'page-1' : kind === 'cover' ? 'cover' : 'back-cover'}`,
    kind,
    ...(pageNumber && { pageNumber }),
    prompt: kind,
    provider: 'local_mock' as const,
    status: 'complete' as const,
    imageUrl: `/mock/${kind}`,
    altText: kind,
    width: 1024,
    height: 1024,
    seed: String(index),
  })),
});

// ───────────────────────────── the suite ─────────────────────────────

describe.each(['local', 'cloud'] as const)(
  'Artifact write coordination vs permanent deletion (%s driver, real Postgres)',
  (driverName) => {
    const prisma = new PrismaService();
    const userIds: string[] = [];
    const bookIds: string[] = [];
    let driver: Driver;
    let coordinator: BookArtifactWriteCoordinator;
    let deletion: BookHardDeletionService;
    let assets: BookAssetService;
    let pageChange: BookPageChangeService;
    let deleteBookSpies: { image: ReturnType<typeof vi.spyOn>; pdf: ReturnType<typeof vi.spyOn> };

    const queue = {
      removeBookWorkIfSafe: vi.fn().mockResolvedValue(undefined),
      hasActiveBookWork: vi.fn().mockResolvedValue(false),
    };
    const photoProcessor = {
      process: vi
        .fn()
        .mockResolvedValue({ buffer: Buffer.from('processed-photo'), contentType: 'image/png' }),
    };

    beforeAll(async () => {
      await prisma.$connect();
    });
    afterAll(async () => {
      await prisma.$disconnect();
    });

    async function setup() {
      driver = await createDriver(driverName);
      coordinator = new BookArtifactWriteCoordinator(prisma, driver.image, driver.pdf);
      const crud = new BookCrudService(prisma);
      deletion = new BookHardDeletionService(
        prisma,
        new CreditsService(prisma),
        queue as never,
        driver.image,
        driver.pdf,
        coordinator,
      );
      assets = new BookAssetService(
        crud,
        prisma,
        driver.pdf,
        driver.image,
        photoProcessor as never,
        coordinator,
      );
      pageChange = new BookPageChangeService(crud, prisma, driver.pdf, driver.image, coordinator);
      deleteBookSpies = {
        image: vi.spyOn(driver.inner.image, 'deleteBookArtifacts'),
        pdf: vi.spyOn(driver.inner.pdf, 'deleteBookArtifacts'),
      };
    }

    afterEach(async () => {
      if (bookIds.length > 0) {
        await prisma.bookArtifactWriteIntent.deleteMany({ where: { bookId: { in: bookIds } } });
        const requests = await prisma.bookDeletionRequest.findMany({
          where: { bookId: { in: bookIds } },
        });
        await prisma.outboxEvent.deleteMany({
          where: { aggregateId: { in: requests.map((r) => r.id) } },
        });
        await prisma.bookDeletionRequest.deleteMany({ where: { bookId: { in: bookIds } } });
        await prisma.bookPage.deleteMany({ where: { bookId: { in: bookIds } } });
        await prisma.book.deleteMany({ where: { id: { in: bookIds } } });
        bookIds.length = 0;
      }
      if (userIds.length > 0) {
        await prisma.creditTransaction.deleteMany({ where: { userId: { in: userIds } } });
        await prisma.user.deleteMany({ where: { id: { in: userIds } } });
        userIds.length = 0;
      }
      vi.clearAllMocks();
      await driver?.dispose();
    });

    async function createUser() {
      const user = await prisma.user.create({
        data: { email: `artifact-writes-${randomUUID()}@example.test`, emailVerified: true },
      });
      userIds.push(user.id);
      return user;
    }

    async function createDraft(userId: string): Promise<Book> {
      const book = await prisma.book.create({
        data: {
          userId,
          status: BookStatus.created,
          childName: 'Mia',
          childAge: 6,
          theme: 'forest',
        },
      });
      bookIds.push(book.id);
      return book;
    }

    /** A completed, published book whose cover/page/back-cover bytes exist in storage. */
    async function createPublishedBook(userId: string) {
      const draft = await createDraft(userId);
      const book = await prisma.book.update({
        where: { id: draft.id },
        data: {
          status: BookStatus.complete,
          publishedRunId: randomUUID(),
          publishedRunFencingVersion: 4,
          previewPdfUrl: '/old.pdf',
          bookPreview: preview() as never,
          imageGenerationResult: imageResult(draft.id) as never,
        },
      });
      const namespace = resolvePublishedImageNamespace(book);
      const keys = {
        cover: publishedImageKey(book.id, namespace, 'cover', undefined, new Map()),
        page: publishedImageKey(book.id, namespace, 'page', 1, new Map()),
        back: publishedImageKey(book.id, namespace, 'back_cover', undefined, new Map()),
      };
      const png = generateMockImagePng('published');
      for (const key of Object.values(keys)) {
        await driver.inner.image.saveImageAsset(key, png, 'image/png');
      }
      return { book, keys };
    }

    async function requestDeletion(userId: string, bookId: string) {
      return deletion.request(userId, UserRole.user, bookId, bookId);
    }

    async function expectRetry(requestId: string, code: string) {
      const err = await deletion.process(requestId).then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(BookDeletionRetryableError);
      expect((err as BookDeletionRetryableError).code).toBe(code);
    }

    async function intents(bookId: string) {
      return prisma.bookArtifactWriteIntent.findMany({ where: { bookId } });
    }

    async function expectFullyDeleted(bookId: string, requestId: string) {
      expect(await prisma.book.findUnique({ where: { id: bookId } })).toBeNull();
      expect(await driver.list(bookId)).toEqual([]);
      expect(await intents(bookId)).toEqual([]);
      expect(
        await prisma.bookDeletionRequest.findUniqueOrThrow({ where: { id: requestId } }),
      ).toMatchObject({ status: BookDeletionStatus.completed, remainingArtifactCount: 0 });
    }

    // ───────── thumbnail ─────────

    it('thumbnail: an admitted writer blocks completion; deletion then sweeps its artifact', async () => {
      await setup();
      const user = await createUser();
      const { book } = await createPublishedBook(user.id);
      const entered = deferred();
      const release = deferred();
      driver.hooks.beforeSaveImage = async (key) => {
        if (!key.endsWith('-thumb')) return;
        entered.resolve();
        await release.promise;
      };

      const writer = assets.getPublishedImage(book.id, user.id, 'cover-thumb');
      await entered.promise;
      const requested = await requestDeletion(user.id, book.id);
      await expectRetry(requested.id, 'BOOK_WRITERS_STILL_ACTIVE');

      // Writer coordination happens BEFORE any storage sweep.
      expect(deleteBookSpies.image).not.toHaveBeenCalled();
      expect(deleteBookSpies.pdf).not.toHaveBeenCalled();
      expect(await prisma.book.findUnique({ where: { id: book.id } })).not.toBeNull();
      expect(
        await prisma.bookDeletionRequest.findUniqueOrThrow({ where: { id: requested.id } }),
      ).toMatchObject({
        status: BookDeletionStatus.retry_pending,
        lastErrorCode: 'BOOK_WRITERS_STILL_ACTIVE',
      });

      release.resolve();
      await writer;
      expect(await intents(book.id)).toEqual([]);

      await requestDeletion(user.id, book.id);
      await deletion.process(requested.id);
      await expectFullyDeleted(book.id, requested.id);
    });

    it('thumbnail: a writer that read its source before deletion cannot recreate an artifact after completion', async () => {
      await setup();
      const user = await createUser();
      const { book, keys } = await createPublishedBook(user.id);
      const read = deferred();
      const release = deferred();
      driver.hooks.afterGetImage = async (key) => {
        if (key !== keys.cover) return;
        driver.hooks.afterGetImage = undefined;
        read.resolve();
        await release.promise;
      };

      const writer = assets.getPublishedImage(book.id, user.id, 'cover-thumb');
      await read.promise;
      const requested = await requestDeletion(user.id, book.id);
      await deletion.process(requested.id); // no admitted writer yet: completes
      await expectFullyDeleted(book.id, requested.id);

      release.resolve();
      await writer.catch(() => undefined); // best-effort cache: response outcome is irrelevant
      expect(await driver.list(book.id)).toEqual([]);
      expect(await intents(book.id)).toEqual([]);
    });

    // ───────── child photo ─────────

    it('photo: losing the database fence after storage succeeded removes the saved bytes', async () => {
      await setup();
      const user = await createUser();
      const book = await createDraft(user.id);
      const entered = deferred();
      const release = deferred();
      driver.hooks.beforeSaveImage = async () => {
        entered.resolve();
        await release.promise;
      };

      const upload = assets.uploadChildPhoto(user.id, book.id, {
        buffer: Buffer.from('raw'),
      } as Express.Multer.File);
      const outcome = upload.then(
        () => null,
        (e: unknown) => e,
      );
      await entered.promise;
      expect(await intents(book.id)).toHaveLength(1);
      await prisma.book.update({ where: { id: book.id }, data: { status: BookStatus.char_build } });
      release.resolve();

      expect(await outcome).toBeInstanceOf(ConflictException);
      expect(await driver.list(book.id)).toEqual([]);
      expect(await intents(book.id)).toEqual([]);
      expect(
        (await prisma.book.findUniqueOrThrow({ where: { id: book.id } })).childPhotoAssetKey,
      ).toBeNull();
    });

    it('photo: a successful upload publishes the key and consumes its intent atomically', async () => {
      await setup();
      const user = await createUser();
      const book = await createDraft(user.id);

      await assets.uploadChildPhoto(user.id, book.id, { buffer: Buffer.from('raw') } as never);

      const stored = await prisma.book.findUniqueOrThrow({ where: { id: book.id } });
      expect(stored.childPhotoAssetKey).toMatch(new RegExp(`^${book.id}/child-photo-`));
      expect(await driver.inner.image.getImageAsset(stored.childPhotoAssetKey!)).toBeDefined();
      expect(await intents(book.id)).toEqual([]);
    });

    it('photo: an upload racing permanent deletion is rejected, cleaned up, and deletion then completes', async () => {
      await setup();
      const user = await createUser();
      const book = await createDraft(user.id);
      const entered = deferred();
      const release = deferred();
      driver.hooks.beforeSaveImage = async () => {
        entered.resolve();
        await release.promise;
      };
      const outcome = assets
        .uploadChildPhoto(user.id, book.id, { buffer: Buffer.from('raw') } as never)
        .then(
          () => null,
          (e: unknown) => e,
        );
      await entered.promise;

      const requested = await requestDeletion(user.id, book.id);
      await expectRetry(requested.id, 'BOOK_WRITERS_STILL_ACTIVE');
      release.resolve();
      expect(await outcome).toBeInstanceOf(ConflictException);
      expect(await driver.list(book.id)).toEqual([]);

      await requestDeletion(user.id, book.id);
      await deletion.process(requested.id);
      await expectFullyDeleted(book.id, requested.id);
    });

    it('photo: new uploads are not admitted once the book is tombstoned', async () => {
      await setup();
      const user = await createUser();
      const book = await createDraft(user.id);
      const requested = await requestDeletion(user.id, book.id);

      await expect(
        coordinator.admit(book.id, 'child_photo', [
          { store: 'image', key: childPhotoAssetKey(book.id, randomUUID()) },
        ]),
      ).rejects.toThrow(/closed/i);
      expect(await intents(book.id)).toEqual([]);

      await deletion.process(requested.id);
      await expectFullyDeleted(book.id, requested.id);
    });

    it('photo: failed cleanup leaves a durable record that recovery finishes, never touching published state', async () => {
      await setup();
      const user = await createUser();
      const book = await createDraft(user.id);
      const entered = deferred();
      const release = deferred();
      driver.hooks.beforeSaveImage = async () => {
        entered.resolve();
        await release.promise;
      };
      const outcome = assets
        .uploadChildPhoto(user.id, book.id, { buffer: Buffer.from('raw') } as never)
        .then(
          () => null,
          (e: unknown) => e,
        );
      await entered.promise;
      await prisma.book.update({ where: { id: book.id }, data: { status: BookStatus.char_build } });
      driver.hooks.failDeletes = true;
      release.resolve();

      // The caller still sees the original conflict, not the cleanup failure.
      expect(await outcome).toBeInstanceOf(ConflictException);
      const [pending] = await intents(book.id);
      expect(pending).toMatchObject({ state: BookArtifactWriteState.cleanup_pending });
      expect(await driver.list(book.id)).toHaveLength(1);

      // Recovery while storage is still failing keeps the record.
      expect(await coordinator.recoverStale({ bookId: book.id })).toMatchObject({
        cleaned: 0,
        failed: 1,
      });
      expect(await intents(book.id)).toHaveLength(1);

      driver.hooks.failDeletes = false;
      expect(await coordinator.recoverStale({ bookId: book.id })).toMatchObject({
        cleaned: 1,
        failed: 0,
      });
      expect(await driver.list(book.id)).toEqual([]);
      expect(await intents(book.id)).toEqual([]);
    });

    it('recovery: an expired active intent is fenced, cleaned, and can no longer be consumed by publication', async () => {
      await setup();
      const user = await createUser();
      const book = await createDraft(user.id);
      const key = childPhotoAssetKey(book.id, randomUUID());
      const intent = await coordinator.admit(book.id, 'child_photo', [{ store: 'image', key }]);
      await driver.inner.image.saveImageAsset(key, Buffer.from('crashed-writer'), 'image/png');
      await prisma.bookArtifactWriteIntent.update({
        where: { id: intent.id },
        data: { leaseExpiresAt: new Date(Date.now() - 1_000) },
      });

      expect(await coordinator.recoverStale({ bookId: book.id })).toMatchObject({
        cleaned: 1,
        failed: 0,
      });
      expect(await driver.list(book.id)).toEqual([]);
      await expect(
        prisma.$transaction((tx) => coordinator.releaseInTransaction(tx, intent)),
      ).rejects.toThrow(/fenced/i);
    });

    it('recovery: an unexpired active intent is left alone', async () => {
      await setup();
      const user = await createUser();
      const book = await createDraft(user.id);
      const key = childPhotoAssetKey(book.id, randomUUID());
      await coordinator.admit(book.id, 'child_photo', [{ store: 'image', key }]);
      await driver.inner.image.saveImageAsset(key, Buffer.from('in-flight'), 'image/png');

      expect(await coordinator.recoverStale({ bookId: book.id })).toMatchObject({
        cleaned: 0,
        failed: 0,
      });
      expect(await driver.list(book.id)).toHaveLength(1);
      expect(await intents(book.id)).toHaveLength(1);
    });

    it('recovery: the leased periodic recovery pass retries pending artifact cleanup', async () => {
      await setup();
      const user = await createUser();
      const book = await createDraft(user.id);
      const key = childPhotoAssetKey(book.id, randomUUID());
      await driver.inner.image.saveImageAsset(key, Buffer.from('left-behind'), 'image/png');
      await prisma.bookArtifactWriteIntent.create({
        data: {
          bookId: book.id,
          kind: 'child_photo',
          artifacts: [{ store: 'image', key }],
          state: BookArtifactWriteState.cleanup_pending,
          leaseExpiresAt: new Date(Date.now() - 1_000),
        },
      });
      const recovery = new GenerationRunRecoveryService(
        prisma,
        {} as never,
        {} as never,
        undefined,
        coordinator,
      );

      // Start from an available lease regardless of what an earlier file left held.
      await prisma.recoveryLease.update({
        where: { id: 'generation_run_recovery' },
        data: { leaseOwner: null, leaseExpiresAt: null },
      });

      const summary = await recovery.recover();

      expect(summary.lockSkipped).toBe(false);
      expect(await driver.list(book.id)).toEqual([]);
      expect(await intents(book.id)).toEqual([]);
    });

    // ───────── text-edit candidate PDF ─────────

    it('text edit: a candidate PDF write racing permanent deletion is fenced out and removed', async () => {
      await setup();
      const user = await createUser();
      const { book } = await createPublishedBook(user.id);
      const entered = deferred();
      const release = deferred();
      driver.hooks.beforeSavePdf = async () => {
        entered.resolve();
        await release.promise;
      };

      const outcome = pageChange
        .updatePageText(user.id, book.id, 1, { text: 'Edited', expectedVersion: 1 })
        .then(
          () => null,
          (e: unknown) => e,
        );
      await entered.promise;
      const requested = await requestDeletion(user.id, book.id);
      await expectRetry(requested.id, 'BOOK_WRITERS_STILL_ACTIVE');
      expect(deleteBookSpies.pdf).not.toHaveBeenCalled();

      release.resolve();
      expect(await outcome).toBeInstanceOf(ConflictException);
      expect((await driver.list(book.id)).filter((key) => key.includes('pdf'))).toEqual([]);

      await requestDeletion(user.id, book.id);
      await deletion.process(requested.id);
      await expectFullyDeleted(book.id, requested.id);
    });

    it('text edit: a publication conflict removes the unpublished candidate PDF', async () => {
      await setup();
      const user = await createUser();
      const { book } = await createPublishedBook(user.id);
      const entered = deferred();
      const release = deferred();
      driver.hooks.beforeSavePdf = async () => {
        entered.resolve();
        await release.promise;
      };

      const outcome = pageChange
        .updatePageText(user.id, book.id, 1, { text: 'Edited', expectedVersion: 1 })
        .then(
          () => null,
          (e: unknown) => e,
        );
      await entered.promise;
      await prisma.bookPage.create({
        data: { bookId: book.id, pageNumber: 1, textContent: 'Concurrent', version: 2 },
      });
      release.resolve();

      expect(await outcome).toBeInstanceOf(ConflictException);
      expect((await driver.list(book.id)).filter((key) => /\.pdf$/.test(key))).toEqual([]);
      expect(await intents(book.id)).toEqual([]);
    });

    it('text edit: a successful publication keeps exactly the referenced candidate and consumes its intent', async () => {
      await setup();
      const user = await createUser();
      const { book } = await createPublishedBook(user.id);

      const updated = await pageChange.updatePageText(user.id, book.id, 1, {
        text: 'Edited',
        expectedVersion: 1,
      });

      expect(updated.bookPreview?.pages[0]).toMatchObject({ text: 'Edited', version: 2 });
      const stored = await prisma.book.findUniqueOrThrow({ where: { id: book.id } });
      const pdfs = (await driver.list(book.id)).filter((key) => /\.pdf$/.test(key));
      expect(pdfs).toHaveLength(1);
      expect(pdfs[0]).toContain(stored.publishedPdfRunId!);
      expect(await intents(book.id)).toEqual([]);
    });

    // ───────── deletion state machine ─────────

    it('deletion: an unexpired active writer blocks; an expired one is accounted for; completion needs a clean sweep', async () => {
      await setup();
      const user = await createUser();
      const book = await createDraft(user.id);
      const requested = await requestDeletion(user.id, book.id);
      const key = childPhotoAssetKey(book.id, randomUUID());
      await driver.inner.image.saveImageAsset(key, Buffer.from('stalled'), 'image/png');
      const intent = await prisma.bookArtifactWriteIntent.create({
        data: {
          bookId: book.id,
          kind: 'child_photo',
          artifacts: [{ store: 'image', key }],
          leaseExpiresAt: new Date(Date.now() + 60_000),
        },
      });

      await expectRetry(requested.id, 'BOOK_WRITERS_STILL_ACTIVE');
      expect(await driver.list(book.id)).toHaveLength(1); // nothing swept yet
      expect(await prisma.book.findUnique({ where: { id: book.id } })).not.toBeNull();

      await prisma.bookArtifactWriteIntent.update({
        where: { id: intent.id },
        data: { leaseExpiresAt: new Date(Date.now() - 1_000) },
      });
      await requestDeletion(user.id, book.id);
      await deletion.process(requested.id);
      await expectFullyDeleted(book.id, requested.id);
    });

    it('deletion: a storage failure keeps cleanup_pending records until a fresh verification passes', async () => {
      await setup();
      const user = await createUser();
      const book = await createDraft(user.id);
      const requested = await requestDeletion(user.id, book.id);
      const key = childPhotoAssetKey(book.id, randomUUID());
      await driver.inner.image.saveImageAsset(key, Buffer.from('orphan'), 'image/png');
      await prisma.bookArtifactWriteIntent.create({
        data: {
          bookId: book.id,
          kind: 'child_photo',
          artifacts: [{ store: 'image', key }],
          state: BookArtifactWriteState.cleanup_pending,
          leaseExpiresAt: new Date(Date.now() - 1_000),
        },
      });
      deleteBookSpies.image.mockResolvedValueOnce({
        complete: false,
        deletedCount: 0,
        remainingCount: 1,
        failureCount: 1,
        errorCode: 'ARTIFACT_DELETE_FAILED',
      });

      await expectRetry(requested.id, 'ARTIFACT_DELETE_FAILED');
      expect(await intents(book.id)).toHaveLength(1);
      expect(await prisma.book.findUnique({ where: { id: book.id } })).not.toBeNull();

      await requestDeletion(user.id, book.id);
      await deletion.process(requested.id);
      await expectFullyDeleted(book.id, requested.id);
    });

    it('deletion: concurrent requests and concurrent processing converge on one completed deletion', async () => {
      await setup();
      const user = await createUser();
      const { book } = await createPublishedBook(user.id);

      const [first, second] = await Promise.all([
        requestDeletion(user.id, book.id),
        requestDeletion(user.id, book.id),
      ]);
      expect(second.id).toBe(first.id);

      const settled = await Promise.allSettled([
        deletion.process(first.id),
        deletion.process(first.id),
      ]);
      for (const result of settled) {
        if (result.status === 'rejected') {
          expect(result.reason).toBeInstanceOf(BookDeletionRetryableError);
        }
      }
      expect(settled.some((result) => result.status === 'fulfilled')).toBe(true);

      await expectFullyDeleted(book.id, first.id);
      await deletion.process(first.id); // already completed: idempotent no-op
      await expectFullyDeleted(book.id, first.id);
    });

    it('deletion: a process interrupted mid-run resumes from the durable processing state', async () => {
      await setup();
      const user = await createUser();
      const { book } = await createPublishedBook(user.id);
      const requested = await requestDeletion(user.id, book.id);
      // Simulate a worker that claimed the request and died before sweeping.
      await prisma.bookDeletionRequest.update({
        where: { id: requested.id },
        data: { status: BookDeletionStatus.processing, attemptCount: 1 },
      });

      await deletion.process(requested.id);

      await expectFullyDeleted(book.id, requested.id);
    });

    // ───────── cloud partial failures (mocked S3 only) ─────────

    if (driverName === 'cloud') {
      it('cloud: a partial DeleteObjects failure keeps the intent; recovery completes once S3 recovers', async () => {
        await setup();
        const user = await createUser();
        const book = await createDraft(user.id);
        const key = childPhotoAssetKey(book.id, randomUUID());
        const intent = await coordinator.admit(book.id, 'child_photo', [{ store: 'image', key }]);
        await driver.inner.image.saveImageAsset(key, Buffer.from('partial'), 'image/png');
        driver.s3!.failDeleteKeys.add(`images/${key}.png`);

        await coordinator.discard(intent);
        expect(await intents(book.id)).toMatchObject([
          { state: BookArtifactWriteState.cleanup_pending },
        ]);
        expect(await driver.list(book.id)).toHaveLength(1);

        driver.s3!.failDeleteKeys.clear();
        expect(await coordinator.recoverStale({ bookId: book.id })).toMatchObject({
          cleaned: 1,
          failed: 0,
        });
        expect(await driver.list(book.id)).toEqual([]);
      });

      it('cloud: a listing failure during the sweep retries without losing the writer records', async () => {
        await setup();
        const user = await createUser();
        const book = await createDraft(user.id);
        const requested = await requestDeletion(user.id, book.id);
        const key = childPhotoAssetKey(book.id, randomUUID());
        await driver.inner.image.saveImageAsset(key, Buffer.from('listed'), 'image/png');
        await prisma.bookArtifactWriteIntent.create({
          data: {
            bookId: book.id,
            kind: 'child_photo',
            artifacts: [{ store: 'image', key }],
            state: BookArtifactWriteState.cleanup_pending,
            leaseExpiresAt: new Date(Date.now() - 1_000),
          },
        });
        driver.s3!.failList = true;

        await expectRetry(requested.id, 'ARTIFACT_LIST_FAILED');
        expect(await intents(book.id)).toHaveLength(1);

        driver.s3!.failList = false;
        await requestDeletion(user.id, book.id);
        await deletion.process(requested.id);
        await expectFullyDeleted(book.id, requested.id);
      });
    }
  },
);
