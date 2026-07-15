import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../../src/database/prisma.service';

/**
 * Durable integration coverage against a real Postgres (see
 * vitest.integration.config.ts) for the Phase B, Slice B1 migration's CHECK
 * constraints on "books" — Prisma's generated client has no way to enforce
 * these at the application layer, so only a real database round-trip proves
 * they actually reject what they're supposed to. See the migration file
 * (prisma/migrations/20260715160805_phase_b1_artifact_namespace_pointers)
 * and generation-artifact-namespace.ts for the invariants these constraints
 * back.
 *
 * Every row created here is deleted (via the owning user's cascade) in
 * afterEach — safe to run against a shared local dev database.
 */
describe('Book artifact-namespace pointer CHECK constraints (real Postgres)', () => {
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

  async function createUser(): Promise<string> {
    const user = await prisma.user.create({
      data: { email: `phase-b1-artifact-namespace-${randomUUID()}@example.test` },
    });
    userIds.push(user.id);
    return user.id;
  }

  describe('valid rows persist', () => {
    it('a fully legacy row (all four pointer fields null) persists', async () => {
      const userId = await createUser();
      const book = await prisma.book.create({ data: { userId } });
      expect(book.lastGenerationRunId).toBeNull();
      expect(book.lastGenerationFencingVersion).toBeNull();
      expect(book.publishedRunId).toBeNull();
      expect(book.publishedRunFencingVersion).toBeNull();
    });

    it('a row with an exact lastGeneration claim pointer persists', async () => {
      const userId = await createUser();
      const runId = randomUUID();
      const book = await prisma.book.create({
        data: { userId, lastGenerationRunId: runId, lastGenerationFencingVersion: 1 },
      });
      expect(book.lastGenerationRunId).toBe(runId);
      expect(book.lastGenerationFencingVersion).toBe(1);
    });

    it('a row with a legacy published pointer (publishedRunId set, publishedRunFencingVersion null) persists — pre-Phase-B completions must remain valid', async () => {
      const userId = await createUser();
      const runId = randomUUID();
      const book = await prisma.book.create({
        data: { userId, status: 'complete', publishedRunId: runId },
      });
      expect(book.publishedRunId).toBe(runId);
      expect(book.publishedRunFencingVersion).toBeNull();
    });

    it('a row with an exact published claim pointer persists', async () => {
      const userId = await createUser();
      const runId = randomUUID();
      const book = await prisma.book.create({
        data: { userId, status: 'complete', publishedRunId: runId, publishedRunFencingVersion: 2 },
      });
      expect(book.publishedRunId).toBe(runId);
      expect(book.publishedRunFencingVersion).toBe(2);
    });

    it('an UPDATE that moves a row from legacy to an exact claim pointer persists', async () => {
      const userId = await createUser();
      const book = await prisma.book.create({ data: { userId } });
      const runId = randomUUID();
      const updated = await prisma.book.update({
        where: { id: book.id },
        data: { lastGenerationRunId: runId, lastGenerationFencingVersion: 1 },
      });
      expect(updated.lastGenerationRunId).toBe(runId);
      expect(updated.lastGenerationFencingVersion).toBe(1);
    });
  });

  describe('invalid pointer pairs are rejected by the DB CHECK constraints', () => {
    it('rejects lastGenerationRunId set without lastGenerationFencingVersion', async () => {
      const userId = await createUser();
      await expect(
        prisma.book.create({ data: { userId, lastGenerationRunId: randomUUID() } }),
      ).rejects.toThrow();
    });

    it('rejects lastGenerationFencingVersion set without lastGenerationRunId', async () => {
      const userId = await createUser();
      await expect(
        prisma.book.create({ data: { userId, lastGenerationFencingVersion: 1 } }),
      ).rejects.toThrow();
    });

    it('rejects a zero lastGenerationFencingVersion', async () => {
      const userId = await createUser();
      await expect(
        prisma.book.create({
          data: { userId, lastGenerationRunId: randomUUID(), lastGenerationFencingVersion: 0 },
        }),
      ).rejects.toThrow();
    });

    it('rejects a negative lastGenerationFencingVersion', async () => {
      const userId = await createUser();
      await expect(
        prisma.book.create({
          data: { userId, lastGenerationRunId: randomUUID(), lastGenerationFencingVersion: -1 },
        }),
      ).rejects.toThrow();
    });

    it('rejects publishedRunFencingVersion set without publishedRunId', async () => {
      const userId = await createUser();
      await expect(
        prisma.book.create({ data: { userId, publishedRunFencingVersion: 1 } }),
      ).rejects.toThrow();
    });

    it('rejects a zero publishedRunFencingVersion', async () => {
      const userId = await createUser();
      await expect(
        prisma.book.create({
          data: {
            userId,
            status: 'complete',
            publishedRunId: randomUUID(),
            publishedRunFencingVersion: 0,
          },
        }),
      ).rejects.toThrow();
    });

    it('rejects a negative publishedRunFencingVersion', async () => {
      const userId = await createUser();
      await expect(
        prisma.book.create({
          data: {
            userId,
            status: 'complete',
            publishedRunId: randomUUID(),
            publishedRunFencingVersion: -1,
          },
        }),
      ).rejects.toThrow();
    });

    it('rejects an UPDATE that leaves lastGenerationRunId set but clears lastGenerationFencingVersion', async () => {
      const userId = await createUser();
      const book = await prisma.book.create({
        data: { userId, lastGenerationRunId: randomUUID(), lastGenerationFencingVersion: 1 },
      });
      await expect(
        prisma.book.update({
          where: { id: book.id },
          data: { lastGenerationFencingVersion: null },
        }),
      ).rejects.toThrow();
    });
  });
});
