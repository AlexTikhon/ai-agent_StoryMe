import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, type CreditReason, type CreditTransaction } from '@prisma/client';
import {
  DEFAULT_CREDIT_TRANSACTIONS_PAGE_SIZE,
  MAX_CREDIT_TRANSACTIONS_PAGE_SIZE,
  type CreditTransactionDirection,
} from '@book/types';
import { PrismaService } from '../database/prisma.service';

export const INSUFFICIENT_CREDITS_CODE = 'INSUFFICIENT_CREDITS';

/** Stable 402 for a valid user without enough credits — distinct from NotFoundException, which means the user itself doesn't exist. */
function insufficientCreditsException(): HttpException {
  return new HttpException(
    {
      error: 'Insufficient credits',
      message: 'Insufficient credits',
      code: INSUFFICIENT_CREDITS_CODE,
    },
    HttpStatus.PAYMENT_REQUIRED,
  );
}

/** True for the P2002 unique-violation Postgres raises for credit_transactions.idempotency_key (see the Phase E1 migration). */
function isIdempotencyKeyViolation(err: unknown): boolean {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== 'P2002') return false;
  const target = err.meta?.['target'];
  return Array.isArray(target) && target.includes('idempotency_key');
}

export interface DeductCreditsInput {
  userId: string;
  amount: number;
  reason: CreditReason;
  bookId?: string;
  idempotencyKey?: string;
}

export interface AddCreditsInput {
  userId: string;
  amount: number;
  reason: CreditReason;
  bookId?: string;
  stripePaymentId?: string;
  idempotencyKey?: string;
}

/** Cost, in credits, of every newly created GenerationRun — initial generation, retry, and regeneration each create one run and each cost exactly this much. See apps/api/docs/credits.md, "Phase E2". */
export const GENERATION_CREDIT_COST = 1;

/**
 * Deterministic idempotency keys for the two generation-owned credit
 * mutations, derived from the durable GenerationRun id rather than any
 * client-supplied value — see apps/api/docs/credits.md, "Phase E2". A run's
 * id is minted once (inside the same transaction that charges it), so these
 * are stable for that run's entire lifetime and unique across every run ever
 * created.
 */
export function generationChargeIdempotencyKey(runId: string): string {
  return `generation:${runId}:charge`;
}

export function generationRefundIdempotencyKey(runId: string): string {
  return `generation:${runId}:refund`;
}

/**
 * Phase G1: deterministic idempotency key for a user-initiated cancellation's
 * compensating refund — distinct from generationRefundIdempotencyKey (the
 * automatic-failure refund) so the two can never collide even in the
 * (structurally prevented — a run can only ever reach one terminal status)
 * case both were somehow attempted for the same run.
 */
export function generationCancellationRefundIdempotencyKey(runId: string): string {
  return `generation:${runId}:cancel_refund`;
}

/** Input for a credit mutation made inside a caller's own Prisma transaction — see CreditsService.deductInTransaction/addInTransaction. Unlike the standalone deduct/add, idempotencyKey is required: internal generation-owned mutations always use a deterministic key, never an absent one. */
export interface DeductCreditsInTransactionInput {
  userId: string;
  amount: number;
  reason: CreditReason;
  bookId?: string;
  idempotencyKey: string;
}

export interface AddCreditsInTransactionInput {
  userId: string;
  amount: number;
  reason: CreditReason;
  bookId?: string;
  stripePaymentId?: string;
  idempotencyKey: string;
}

export interface CreditBalance {
  credits: number;
  creditsUpdatedAt: Date | null;
}

export interface GetCreditTransactionsInput {
  cursor?: string;
  limit?: number;
  direction?: CreditTransactionDirection;
}

export interface CreditTransactionsResult {
  items: CreditTransaction[];
  nextCursor: string | null;
}

interface MutateInput {
  userId: string;
  /** Signed change to apply to User.credits — negative for a debit, positive for a credit/grant. */
  delta: number;
  reason: CreditReason;
  bookId?: string | undefined;
  stripePaymentId?: string | undefined;
  idempotencyKey?: string | undefined;
}

/**
 * Owns every mutation of User.credits — the canonical current balance — and
 * its matching CreditTransaction ledger row. See invariants in
 * apps/api/docs/credits.md: a debit atomically verifies sufficient balance,
 * decrements, and inserts a ledger row with the exact resulting
 * balanceAfter; the balance is never derived by summing transactions, since
 * existing users start with a schema-default balance and may have no
 * historical ledger rows at all.
 */
@Injectable()
export class CreditsService {
  constructor(private readonly prisma: PrismaService) {}

  async getBalance(userId: string): Promise<CreditBalance> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { credits: true, creditsUpdatedAt: true },
    });
    if (!user) throw new NotFoundException('User not found');
    return user;
  }

  /**
   * Atomically verifies sufficient balance, decrements it, and inserts a
   * negative ledger row — see `mutate`. Throws the stable 402
   * INSUFFICIENT_CREDITS HttpException for a real user with too few credits,
   * distinct from NotFoundException for an unknown userId.
   */
  async deduct(input: DeductCreditsInput): Promise<CreditTransaction> {
    this.assertValidAmount(input.amount);
    return this.mutate({
      userId: input.userId,
      delta: -input.amount,
      reason: input.reason,
      bookId: input.bookId,
      idempotencyKey: input.idempotencyKey,
    });
  }

  /** Atomically increments the balance and inserts a positive ledger row — see `mutate`. */
  async add(input: AddCreditsInput): Promise<CreditTransaction> {
    this.assertValidAmount(input.amount);
    return this.mutate({
      userId: input.userId,
      delta: input.amount,
      reason: input.reason,
      bookId: input.bookId,
      stripePaymentId: input.stripePaymentId,
      idempotencyKey: input.idempotencyKey,
    });
  }

  /**
   * Debits credits as one write inside a transaction the caller already
   * holds — used by BooksService.createRunAndSchedule so the GenerationRun
   * create, the credit debit, the Book transition, and the OutboxEvent
   * insert all commit or roll back together (see apps/api/docs/credits.md,
   * "Phase E2"). Never opens its own transaction (no nested
   * `$transaction`) and never catches an idempotency-key conflict — either
   * kind of failure here must abort and roll back the caller's entire
   * transaction, not be swallowed and retried in place, so the run/Book/
   * outbox writes made earlier in the same transaction are undone too.
   */
  async deductInTransaction(
    tx: Prisma.TransactionClient,
    input: DeductCreditsInTransactionInput,
  ): Promise<CreditTransaction> {
    this.assertValidAmount(input.amount);
    return this.mutateCore(tx, {
      userId: input.userId,
      delta: -input.amount,
      reason: input.reason,
      bookId: input.bookId,
      idempotencyKey: input.idempotencyKey,
    });
  }

  /** Credits (refunds) as one write inside a transaction the caller already holds — see deductInTransaction's doc comment; same no-nested-transaction, no-swallowed-conflict reasoning applies to GenerationRunCoordinator's refund-on-failure write. */
  async addInTransaction(
    tx: Prisma.TransactionClient,
    input: AddCreditsInTransactionInput,
  ): Promise<CreditTransaction> {
    this.assertValidAmount(input.amount);
    return this.mutateCore(tx, {
      userId: input.userId,
      delta: input.amount,
      reason: input.reason,
      bookId: input.bookId,
      stripePaymentId: input.stripePaymentId,
      idempotencyKey: input.idempotencyKey,
    });
  }

  async getTransactions(
    userId: string,
    query: GetCreditTransactionsInput,
  ): Promise<CreditTransactionsResult> {
    const limit = Math.min(
      Math.max(query.limit ?? DEFAULT_CREDIT_TRANSACTIONS_PAGE_SIZE, 1),
      MAX_CREDIT_TRANSACTIONS_PAGE_SIZE,
    );
    const amountFilter =
      query.direction === 'debit'
        ? { lt: 0 }
        : query.direction === 'credit'
          ? { gt: 0 }
          : undefined;

    const rows = await this.prisma.creditTransaction.findMany({
      where: { userId, ...(amountFilter ? { amount: amountFilter } : {}) },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
    });

    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    return {
      items,
      nextCursor: hasMore ? (items[items.length - 1]?.id ?? null) : null,
    };
  }

  private assertValidAmount(amount: number): void {
    if (!Number.isInteger(amount) || amount <= 0) {
      throw new BadRequestException('Credit amount must be a positive integer');
    }
  }

  /**
   * The one place User.credits is ever written. `delta`'s sign decides
   * whether the conditional update also guards against an insufficient
   * balance (delta < 0) or applies unconditionally (delta > 0, a
   * credit/grant can never fail on balance alone).
   *
   * The balance UPDATE and the CreditTransaction INSERT happen inside one
   * interactive transaction: Postgres's row lock on the UPDATE serializes
   * concurrent mutations of the same user (the loser's WHERE re-evaluates
   * against the winner's already-committed balance, so it can never
   * over-debit), and any failure after the UPDATE — including the ledger
   * INSERT itself hitting the idempotency-key unique constraint — rolls the
   * whole transaction back, so the balance mutation and its ledger row are
   * never observed apart.
   *
   * `idempotencyKey`, when supplied, makes a duplicate call a safe no-op
   * that returns the original result rather than mutating the balance a
   * second time. The DB's unique constraint — not a check-then-insert read —
   * is what actually enforces this for two genuinely concurrent duplicate
   * calls: both may pass the balance check, but only one INSERT can win: the
   * other's transaction (this same one) rolls back entirely, undoing its
   * balance change too.
   */
  private async mutate(input: MutateInput): Promise<CreditTransaction> {
    const { idempotencyKey } = input;

    if (idempotencyKey) {
      const existing = await this.prisma.creditTransaction.findUnique({
        where: { idempotencyKey },
      });
      if (existing) return existing;
    }

    try {
      return await this.prisma.$transaction((tx) => this.mutateCore(tx, input));
    } catch (err) {
      if (idempotencyKey && isIdempotencyKeyViolation(err)) {
        const existing = await this.prisma.creditTransaction.findUnique({
          where: { idempotencyKey },
        });
        if (existing) return existing;
      }
      throw err;
    }
  }

  /**
   * The actual balance UPDATE + CreditTransaction INSERT — the one place
   * User.credits is ever written, shared by every caller regardless of
   * whether it owns its own transaction (`mutate`, used by the public
   * deduct/add) or is composing into a larger one it doesn't own
   * (deductInTransaction/addInTransaction, used by generation scheduling and
   * refunds). Takes a `Prisma.TransactionClient` rather than opening one
   * itself — see this class's own doc comment for why the UPDATE+INSERT pair
   * must always execute inside a transaction, just not necessarily one this
   * method creates.
   */
  private async mutateCore(
    tx: Prisma.TransactionClient,
    input: MutateInput,
  ): Promise<CreditTransaction> {
    const { userId, delta, reason, bookId, stripePaymentId, idempotencyKey } = input;

    const where: Prisma.UserWhereInput =
      delta < 0 ? { id: userId, credits: { gte: -delta } } : { id: userId };
    const result = await tx.user.updateMany({
      where,
      data: { credits: { increment: delta }, creditsUpdatedAt: new Date() },
    });

    if (result.count === 0) {
      const exists = await tx.user.findUnique({ where: { id: userId }, select: { id: true } });
      if (!exists) throw new NotFoundException('User not found');
      throw insufficientCreditsException();
    }

    const user = await tx.user.findUniqueOrThrow({
      where: { id: userId },
      select: { credits: true },
    });

    return tx.creditTransaction.create({
      data: {
        userId,
        bookId: bookId ?? null,
        amount: delta,
        balanceAfter: user.credits,
        reason,
        stripePaymentId: stripePaymentId ?? null,
        idempotencyKey: idempotencyKey ?? null,
      },
    });
  }
}
