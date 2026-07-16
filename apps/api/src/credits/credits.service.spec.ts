import { describe, it, expect, beforeEach } from 'vitest';
import { BadRequestException, HttpStatus, NotFoundException } from '@nestjs/common';
import { Prisma, type CreditTransaction } from '@prisma/client';
import { CreditsService, INSUFFICIENT_CREDITS_CODE } from './credits.service';
import { createMockPrisma } from '../common/test-utils/mock-prisma';

type MockPrisma = ReturnType<typeof createMockPrisma>;

function makeTransaction(overrides: Partial<CreditTransaction> = {}): CreditTransaction {
  return {
    id: 'tx-1',
    userId: 'u-1',
    bookId: null,
    amount: -1,
    balanceAfter: 2,
    reason: 'book_creation' as CreditTransaction['reason'],
    stripePaymentId: null,
    idempotencyKey: null,
    createdAt: new Date('2026-07-16T00:00:00.000Z'),
    ...overrides,
  };
}

/** Simulates the P2002 Postgres raises for credit_transactions.idempotency_key. */
function idempotencyKeyViolationError(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed.', {
    code: 'P2002',
    clientVersion: '5.17.0',
    meta: { modelName: 'CreditTransaction', target: ['idempotency_key'] },
  });
}

describe('CreditsService', () => {
  let prisma: MockPrisma;
  let service: CreditsService;

  beforeEach(() => {
    prisma = createMockPrisma();
    prisma.$transaction.mockImplementation((cb: (tx: MockPrisma) => unknown) => cb(prisma));
    service = new CreditsService(prisma as never);
  });

  describe('getBalance', () => {
    it('returns the balance and creditsUpdatedAt for an existing user', async () => {
      prisma.user.findUnique.mockResolvedValue({
        credits: 3,
        creditsUpdatedAt: new Date('2026-07-01T00:00:00.000Z'),
      });

      const result = await service.getBalance('u-1');

      expect(result).toEqual({
        credits: 3,
        creditsUpdatedAt: new Date('2026-07-01T00:00:00.000Z'),
      });
      expect(prisma.user.findUnique).toHaveBeenCalledWith({
        where: { id: 'u-1' },
        select: { credits: true, creditsUpdatedAt: true },
      });
    });

    it('throws NotFoundException for an unknown user', async () => {
      prisma.user.findUnique.mockResolvedValue(null);

      await expect(service.getBalance('missing')).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('deduct — validation', () => {
    it.each([0, -1, 1.5, NaN])(
      'rejects a non-positive-integer amount (%s) without touching the DB',
      async (amount) => {
        await expect(
          service.deduct({ userId: 'u-1', amount, reason: 'book_creation' as never }),
        ).rejects.toBeInstanceOf(BadRequestException);
        expect(prisma.$transaction).not.toHaveBeenCalled();
      },
    );
  });

  describe('add — validation', () => {
    it.each([0, -1, 2.5])(
      'rejects a non-positive-integer amount (%s) without touching the DB',
      async (amount) => {
        await expect(
          service.add({ userId: 'u-1', amount, reason: 'purchase' as never }),
        ).rejects.toBeInstanceOf(BadRequestException);
        expect(prisma.$transaction).not.toHaveBeenCalled();
      },
    );
  });

  describe('deduct — success', () => {
    it('atomically decrements the balance and inserts a negative ledger row with the resulting balanceAfter', async () => {
      prisma.user.updateMany.mockResolvedValue({ count: 1 });
      prisma.user.findUniqueOrThrow.mockResolvedValue({ credits: 2 });
      const created = makeTransaction({ amount: -1, balanceAfter: 2 });
      prisma.creditTransaction.create.mockResolvedValue(created);

      const result = await service.deduct({
        userId: 'u-1',
        amount: 1,
        reason: 'book_creation' as never,
        bookId: 'b-1',
      });

      expect(prisma.user.updateMany).toHaveBeenCalledWith({
        where: { id: 'u-1', credits: { gte: 1 } },
        data: { credits: { increment: -1 }, creditsUpdatedAt: expect.any(Date) },
      });
      expect(prisma.creditTransaction.create).toHaveBeenCalledWith({
        data: {
          userId: 'u-1',
          bookId: 'b-1',
          amount: -1,
          balanceAfter: 2,
          reason: 'book_creation',
          stripePaymentId: null,
          idempotencyKey: null,
        },
      });
      expect(result).toBe(created);
    });
  });

  describe('deduct — insufficient credits', () => {
    it('throws a 402 INSUFFICIENT_CREDITS error and never inserts a ledger row when the user exists but lacks balance', async () => {
      prisma.user.updateMany.mockResolvedValue({ count: 0 });
      prisma.user.findUnique.mockResolvedValue({ id: 'u-1' });

      const failure = service.deduct({
        userId: 'u-1',
        amount: 5,
        reason: 'book_creation' as never,
      });

      await expect(failure).rejects.toMatchObject({
        status: HttpStatus.PAYMENT_REQUIRED,
        response: expect.objectContaining({ code: INSUFFICIENT_CREDITS_CODE }),
      });
      expect(prisma.creditTransaction.create).not.toHaveBeenCalled();
    });
  });

  describe('deduct — unknown user', () => {
    it('throws NotFoundException, not the insufficient-credits error, when the user does not exist', async () => {
      prisma.user.updateMany.mockResolvedValue({ count: 0 });
      prisma.user.findUnique.mockResolvedValue(null);

      await expect(
        service.deduct({ userId: 'missing', amount: 1, reason: 'book_creation' as never }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.creditTransaction.create).not.toHaveBeenCalled();
    });
  });

  describe('add — success', () => {
    it('unconditionally increments the balance (no gte guard) and inserts a positive ledger row', async () => {
      prisma.user.updateMany.mockResolvedValue({ count: 1 });
      prisma.user.findUniqueOrThrow.mockResolvedValue({ credits: 13 });
      const created = makeTransaction({
        amount: 10,
        balanceAfter: 13,
        reason: 'purchase' as never,
      });
      prisma.creditTransaction.create.mockResolvedValue(created);

      const result = await service.add({
        userId: 'u-1',
        amount: 10,
        reason: 'purchase' as never,
        stripePaymentId: 'pi_123',
      });

      expect(prisma.user.updateMany).toHaveBeenCalledWith({
        where: { id: 'u-1' },
        data: { credits: { increment: 10 }, creditsUpdatedAt: expect.any(Date) },
      });
      expect(prisma.creditTransaction.create).toHaveBeenCalledWith({
        data: {
          userId: 'u-1',
          bookId: null,
          amount: 10,
          balanceAfter: 13,
          reason: 'purchase',
          stripePaymentId: 'pi_123',
          idempotencyKey: null,
        },
      });
      expect(result).toBe(created);
    });
  });

  describe('idempotency', () => {
    it('returns the existing transaction without mutating the balance when idempotencyKey was already applied', async () => {
      const existing = makeTransaction({ idempotencyKey: 'key-1' });
      prisma.creditTransaction.findUnique.mockResolvedValue(existing);

      const result = await service.deduct({
        userId: 'u-1',
        amount: 1,
        reason: 'book_creation' as never,
        idempotencyKey: 'key-1',
      });

      expect(result).toBe(existing);
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(prisma.user.updateMany).not.toHaveBeenCalled();
    });

    it('on a concurrent duplicate (idempotency-key unique-constraint violation), re-fetches and returns the winner instead of double-mutating', async () => {
      prisma.creditTransaction.findUnique.mockResolvedValueOnce(null); // pre-check: not yet applied
      prisma.user.updateMany.mockResolvedValue({ count: 1 });
      prisma.user.findUniqueOrThrow.mockResolvedValue({ credits: 2 });
      prisma.creditTransaction.create.mockRejectedValue(idempotencyKeyViolationError());
      const winner = makeTransaction({ idempotencyKey: 'key-1', balanceAfter: 2 });
      prisma.creditTransaction.findUnique.mockResolvedValueOnce(winner); // post-conflict re-fetch

      const result = await service.deduct({
        userId: 'u-1',
        amount: 1,
        reason: 'book_creation' as never,
        idempotencyKey: 'key-1',
      });

      expect(result).toBe(winner);
    });

    it('re-throws a P2002 on a different constraint unchanged (not misclassified as an idempotency replay)', async () => {
      prisma.creditTransaction.findUnique.mockResolvedValue(null);
      prisma.user.updateMany.mockResolvedValue({ count: 1 });
      prisma.user.findUniqueOrThrow.mockResolvedValue({ credits: 2 });
      const otherViolation = new Prisma.PrismaClientKnownRequestError('Unique constraint failed.', {
        code: 'P2002',
        clientVersion: '5.17.0',
        meta: { modelName: 'CreditTransaction', target: ['some_other_column'] },
      });
      prisma.creditTransaction.create.mockRejectedValue(otherViolation);

      await expect(
        service.deduct({
          userId: 'u-1',
          amount: 1,
          reason: 'book_creation' as never,
          idempotencyKey: 'key-1',
        }),
      ).rejects.toBe(otherViolation);
    });
  });

  describe('getTransactions — pagination', () => {
    it('applies the default page size and reports no next cursor when fewer rows than the limit exist', async () => {
      const rows = [makeTransaction({ id: 'tx-2' }), makeTransaction({ id: 'tx-1' })];
      prisma.creditTransaction.findMany.mockResolvedValue(rows);

      const result = await service.getTransactions('u-1', {});

      expect(prisma.creditTransaction.findMany).toHaveBeenCalledWith({
        where: { userId: 'u-1' },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 21,
      });
      expect(result).toEqual({ items: rows, nextCursor: null });
    });

    it('returns nextCursor and trims the extra lookahead row when more rows exist than the limit', async () => {
      const rows = [
        makeTransaction({ id: 'tx-3' }),
        makeTransaction({ id: 'tx-2' }),
        makeTransaction({ id: 'tx-1' }),
      ];
      prisma.creditTransaction.findMany.mockResolvedValue(rows);

      const result = await service.getTransactions('u-1', { limit: 2 });

      expect(result.items).toEqual([rows[0], rows[1]]);
      expect(result.nextCursor).toBe('tx-2');
    });

    it('clamps a limit above the maximum page size', async () => {
      prisma.creditTransaction.findMany.mockResolvedValue([]);

      await service.getTransactions('u-1', { limit: 10_000 });

      expect(prisma.creditTransaction.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: 101 }),
      );
    });

    it('clamps a limit below the minimum page size', async () => {
      prisma.creditTransaction.findMany.mockResolvedValue([]);

      await service.getTransactions('u-1', { limit: -5 });

      expect(prisma.creditTransaction.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: 2 }),
      );
    });

    it('passes the cursor through with skip: 1', async () => {
      prisma.creditTransaction.findMany.mockResolvedValue([]);

      await service.getTransactions('u-1', { cursor: 'tx-5' });

      expect(prisma.creditTransaction.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ cursor: { id: 'tx-5' }, skip: 1 }),
      );
    });

    it('filters to debits only (amount < 0) when direction is "debit"', async () => {
      prisma.creditTransaction.findMany.mockResolvedValue([]);

      await service.getTransactions('u-1', { direction: 'debit' });

      expect(prisma.creditTransaction.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { userId: 'u-1', amount: { lt: 0 } } }),
      );
    });

    it('filters to credits only (amount > 0) when direction is "credit"', async () => {
      prisma.creditTransaction.findMany.mockResolvedValue([]);

      await service.getTransactions('u-1', { direction: 'credit' });

      expect(prisma.creditTransaction.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { userId: 'u-1', amount: { gt: 0 } } }),
      );
    });
  });
});
