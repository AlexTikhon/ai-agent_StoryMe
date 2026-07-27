import * as bcrypt from 'bcryptjs';
import { PrismaClient } from '@prisma/client';
import Redis from 'ioredis';
import { rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';

export const E2E_EMAIL_SUFFIX = '@e2e.storyme.test';
export const E2E_LOGIN_EMAIL = `verified-login${E2E_EMAIL_SUFFIX}`;
export const E2E_LOGIN_PASSWORD = 'StoryMeE2E1!';

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
      await prisma.user.create({
        data: {
          email: E2E_LOGIN_EMAIL,
          passwordHash: await bcrypt.hash(E2E_LOGIN_PASSWORD, 12),
          name: 'Verified E2E User',
          emailVerified: true,
          emailVerifiedAt: new Date(),
          credits: 3,
        },
      });
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
