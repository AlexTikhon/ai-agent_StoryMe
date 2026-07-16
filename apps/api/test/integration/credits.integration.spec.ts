import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { HttpStatus } from '@nestjs/common';
import { PrismaService } from '../../src/database/prisma.service';
import { CreditsService, INSUFFICIENT_CREDITS_CODE } from '../../src/credits/credits.service';

/**
 * Durable integration coverage against a real Postgres (see
 * vitest.integration.config.ts) — proves the invariants that depend on
 * Postgres's actual row-locking/READ-COMMITTED re-check semantics, which a
 * mocked PrismaClient cannot verify: a debit's balance check and ledger
 * insert commit or roll back together, two genuinely concurrent debits
 * against a too-small balance let exactly one win, and a duplicate
 * idempotency key can never mutate the balance twice.
 *
 * Every row created here is deleted in afterEach — safe to run against a
 * shared local dev database.
 */
describe('CreditsService (real Postgres)', () => {
  const prisma = new PrismaService();
  const service = new CreditsService(prisma);
  const userIds: string[] = [];

  beforeAll(async () => {
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  afterEach(async () => {
    if (userIds.length > 0) {
      // CreditTransaction.user has no onDelete: Cascade (an intentional
      // financial-audit-trail choice) — delete ledger rows before the user
      // row they reference.
      await prisma.creditTransaction.deleteMany({ where: { userId: { in: userIds } } });
      await prisma.user.deleteMany({ where: { id: { in: userIds } } });
      userIds.length = 0;
    }
  });

  async function createUser(credits: number): Promise<string> {
    const user = await prisma.user.create({
      data: { email: `credits-integration-${randomUUID()}@example.test`, credits },
    });
    userIds.push(user.id);
    return user.id;
  }

  it('a successful debit atomically decrements the balance and inserts one ledger row with the matching balanceAfter', async () => {
    const userId = await createUser(5);

    const tx = await service.deduct({ userId, amount: 2, reason: 'book_creation' });

    expect(tx.amount).toBe(-2);
    expect(tx.balanceAfter).toBe(3);
    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(user.credits).toBe(3);
    expect(user.creditsUpdatedAt).not.toBeNull();
    const rows = await prisma.creditTransaction.findMany({ where: { userId } });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.balanceAfter).toBe(3);
  });

  it('an insufficient debit changes neither the balance nor the ledger', async () => {
    const userId = await createUser(1);

    await expect(
      service.deduct({ userId, amount: 2, reason: 'book_creation' }),
    ).rejects.toMatchObject({
      status: HttpStatus.PAYMENT_REQUIRED,
      response: expect.objectContaining({ code: INSUFFICIENT_CREDITS_CODE }),
    });

    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(user.credits).toBe(1);
    expect(user.creditsUpdatedAt).toBeNull();
    const rows = await prisma.creditTransaction.findMany({ where: { userId } });
    expect(rows).toHaveLength(0);
  });

  it('a forced ledger-insert failure (bookId foreign-key violation) rolls back the balance update inside the same transaction', async () => {
    const userId = await createUser(5);

    await expect(
      service.deduct({
        userId,
        amount: 1,
        reason: 'book_creation',
        bookId: randomUUID(), // no such Book row — CreditTransaction.create's FK constraint fails
      }),
    ).rejects.toThrow();

    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(user.credits).toBe(5); // the UPDATE that ran earlier in the same transaction was rolled back
    const rows = await prisma.creditTransaction.findMany({ where: { userId } });
    expect(rows).toHaveLength(0);
  });

  it('two genuinely concurrent debits against a one-credit balance let exactly one succeed, leave the balance at zero, and persist exactly one ledger row', async () => {
    const userId = await createUser(1);

    const [resultA, resultB] = await Promise.allSettled([
      service.deduct({ userId, amount: 1, reason: 'book_creation' }),
      service.deduct({ userId, amount: 1, reason: 'book_creation' }),
    ]);

    const fulfilled = [resultA, resultB].filter((r) => r.status === 'fulfilled');
    const rejected = [resultA, resultB].filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
      status: HttpStatus.PAYMENT_REQUIRED,
      response: expect.objectContaining({ code: INSUFFICIENT_CREDITS_CODE }),
    });

    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(user.credits).toBe(0);
    const rows = await prisma.creditTransaction.findMany({ where: { userId } });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.balanceAfter).toBe(0);
  });

  it('a credit/grant atomically increments the balance and records the correct resulting balanceAfter', async () => {
    const userId = await createUser(3);

    const tx = await service.add({
      userId,
      amount: 10,
      reason: 'purchase',
      stripePaymentId: 'pi_test',
    });

    expect(tx.amount).toBe(10);
    expect(tx.balanceAfter).toBe(13);
    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(user.credits).toBe(13);
  });

  it('duplicate idempotency keys cannot mutate the balance twice, including under genuine concurrency', async () => {
    const userId = await createUser(5);
    const idempotencyKey = `dedupe-${randomUUID()}`;

    const [resultA, resultB] = await Promise.all([
      service.deduct({ userId, amount: 1, reason: 'book_creation', idempotencyKey }),
      service.deduct({ userId, amount: 1, reason: 'book_creation', idempotencyKey }),
    ]);

    // Both calls converge on the same single ledger row's result — one
    // genuinely mutated the balance, the other's insert lost the unique-key
    // race and was resolved by re-fetching the winner, not a second debit.
    expect(resultA.id).toBe(resultB.id);
    expect(resultA.balanceAfter).toBe(resultB.balanceAfter);

    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(user.credits).toBe(4); // decremented exactly once, not twice
    const rows = await prisma.creditTransaction.findMany({ where: { userId } });
    expect(rows).toHaveLength(1);

    // A subsequent call with the same key is a pure replay — still no further mutation.
    const replay = await service.deduct({
      userId,
      amount: 1,
      reason: 'book_creation',
      idempotencyKey,
    });
    expect(replay.id).toBe(resultA.id);
    const userAfterReplay = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(userAfterReplay.credits).toBe(4);
  });

  it('rejects an unknown userId as NotFoundException, not the insufficient-credits error', async () => {
    await expect(
      service.deduct({ userId: randomUUID(), amount: 1, reason: 'book_creation' }),
    ).rejects.toMatchObject({ status: HttpStatus.NOT_FOUND });
  });
});
