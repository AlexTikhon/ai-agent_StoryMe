import * as bcrypt from 'bcryptjs';
import { BookStatus, PrismaClient } from '@prisma/client';
import Redis from 'ioredis';
import { rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';

export const E2E_EMAIL_SUFFIX = '@e2e.storyme.test';
export const E2E_LOGIN_EMAIL = `verified-login${E2E_EMAIL_SUFFIX}`;
export const E2E_LOGIN_PASSWORD = 'StoryMeE2E1!';
export const E2E_RETRY_BOOK_ID = '00000000-0000-4000-8000-000000000006';
export const E2E_PUBLICATION_COMPLETE_BOOK_ID = '00000000-0000-4000-8000-000000000011';
export const E2E_PUBLICATION_RUNNING_BOOK_ID = '00000000-0000-4000-8000-000000000012';
export const E2E_PUBLICATION_FAILED_BOOK_ID = '00000000-0000-4000-8000-000000000013';
export const E2E_PUBLICATION_CANCELLED_BOOK_ID = '00000000-0000-4000-8000-000000000014';
export const E2E_INITIAL_FAILED_BOOK_ID = '00000000-0000-4000-8000-000000000015';

const publicationPreview = {
  title: 'Published Family Story',
  subtitle: 'A safe disposable E2E fixture',
  cover: {
    title: 'Published Family Story',
    subtitle: 'A safe disposable E2E fixture',
    childName: 'Reader',
    illustrationPrompt: 'Disposable mock cover',
  },
  pages: [
    {
      pageNumber: 1,
      title: 'The published page',
      text: 'This disposable mock page remains readable.',
      illustrationPrompt: 'Disposable mock page',
      layout: 'image_top_text_bottom',
      learningGoal: 'Reliability',
      version: 1,
    },
  ],
  backCover: {
    message: 'The end',
    educationalSummary: 'Published versions remain available.',
  },
  metadata: {
    language: 'en',
    theme: 'Reliability',
    childAge: 7,
    totalPages: 1,
    generatedBy: 'LocalPipelineAgent',
  },
};

function assertDedicatedE2eTargets(): void {
  const databaseUrl = process.env['DATABASE_URL'];
  const redisUrl = process.env['REDIS_URL'];
  if (!databaseUrl || !redisUrl) {
    throw new Error('DATABASE_URL and REDIS_URL are required for E2E fixture management.');
  }

  const databaseName = new URL(databaseUrl).pathname.replace(/^\//, '');
  const redisDatabase = new URL(redisUrl).pathname.replace(/^\//, '');
  if (!databaseName.toLowerCase().includes('e2e')) {
    throw new Error(
      `Refusing E2E fixture reset: database name "${databaseName}" does not contain "e2e".`,
    );
  }
  if (!redisDatabase || redisDatabase === '0') {
    throw new Error('Refusing E2E fixture reset: REDIS_URL must select a non-zero database.');
  }
}

async function resetFixtures(seed: boolean): Promise<void> {
  assertDedicatedE2eTargets();
  const prisma = new PrismaClient();
  const redis = new Redis(process.env['REDIS_URL']!);
  try {
    await redis.flushdb();
    const users = await prisma.user.findMany({
      where: { email: { endsWith: E2E_EMAIL_SUFFIX } },
      select: {
        id: true,
        books: { select: { id: true } },
      },
    });
    const userIds = users.map(({ id }) => id);
    const bookIds = users.flatMap(({ books }) => books.map(({ id }) => id));

    if (userIds.length > 0) {
      await prisma.$transaction([
        // CreditTransaction intentionally retains financial history in normal
        // user flows, so its relation is the one user FK without a cascade.
        prisma.creditTransaction.deleteMany({ where: { userId: { in: userIds } } }),
        prisma.user.deleteMany({ where: { id: { in: userIds } } }),
      ]);
    }

    const tmpRoot = resolve(__dirname, '..', 'tmp');
    await Promise.all(
      bookIds.flatMap((bookId) => [
        rm(join(tmpRoot, 'books', bookId), { recursive: true, force: true }),
        rm(join(tmpRoot, 'images', 'books', bookId), { recursive: true, force: true }),
      ]),
    );

    if (seed) {
      const user = await prisma.user.create({
        data: {
          email: E2E_LOGIN_EMAIL,
          passwordHash: await bcrypt.hash(E2E_LOGIN_PASSWORD, 12),
          name: 'Verified E2E User',
          emailVerified: true,
          emailVerifiedAt: new Date(),
          credits: 10,
        },
      });
      await prisma.book.create({
        data: {
          id: E2E_RETRY_BOOK_ID,
          userId: user.id,
          status: BookStatus.failed,
          title: 'Retry Journey Fixture',
          childName: 'Riley',
          childAge: 7,
          language: 'en',
          theme: 'Trying again after a setback',
          pageCount: 4,
          errorMessage: 'Deterministic E2E fixture failure',
        },
      });
      for (const fixture of [
        {
          id: E2E_PUBLICATION_COMPLETE_BOOK_ID,
          status: BookStatus.complete,
          title: 'Complete Publication Fixture',
        },
        {
          id: E2E_PUBLICATION_RUNNING_BOOK_ID,
          status: BookStatus.char_build,
          title: 'Running Regeneration Fixture',
        },
        {
          id: E2E_PUBLICATION_FAILED_BOOK_ID,
          status: BookStatus.failed,
          title: 'Failed Regeneration Fixture',
          errorMessage: 'Disposable failed regeneration',
        },
        {
          id: E2E_PUBLICATION_CANCELLED_BOOK_ID,
          status: BookStatus.cancelled,
          title: 'Cancelled Regeneration Fixture',
        },
      ]) {
        await prisma.book.create({
          data: {
            ...fixture,
            userId: user.id,
            childName: 'Reader',
            childAge: 7,
            language: 'en',
            theme: 'Reliability',
            pageCount: 4,
            previewPdfUrl: 'e2e/disposable-published.pdf',
            bookPreview: publicationPreview,
          },
        });
      }
      await prisma.book.create({
        data: {
          id: E2E_INITIAL_FAILED_BOOK_ID,
          userId: user.id,
          status: BookStatus.failed,
          title: 'Failed Initial Generation Fixture',
          childName: 'Reader',
          childAge: 7,
          language: 'en',
          theme: 'Reliability',
          pageCount: 4,
          errorMessage: 'Disposable initial failure',
        },
      });
    } else {
      // The API/worker webServer is still alive while Playwright runs global
      // teardown and may recreate a BullMQ metadata key after the initial
      // flush. Finish cleanup with a second flush after all durable work has
      // been removed so the disposable Redis DB is empty at handoff.
      await redis.flushdb();
    }
  } finally {
    redis.disconnect();
    await prisma.$disconnect();
  }
}

async function main(): Promise<void> {
  const mode = process.argv[2];
  if (mode !== 'seed' && mode !== 'cleanup') {
    throw new Error('Usage: e2e-fixtures.ts <seed|cleanup>');
  }
  await resetFixtures(mode === 'seed');
  console.log(`E2E fixtures ${mode === 'seed' ? 'seeded' : 'cleaned up'}.`);
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
