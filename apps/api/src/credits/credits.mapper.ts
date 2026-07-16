import type { CreditTransaction } from '@prisma/client';
import { CreditReason, type CreditBalanceDto, type CreditTransactionDto } from '@book/types';
import type { CreditBalance } from './credits.service';

export function toCreditBalanceDto(balance: CreditBalance): CreditBalanceDto {
  return {
    balance: balance.credits,
    creditsUpdatedAt: balance.creditsUpdatedAt ? balance.creditsUpdatedAt.toISOString() : null,
  };
}

export function toCreditTransactionDto(tx: CreditTransaction): CreditTransactionDto {
  return {
    id: tx.id,
    bookId: tx.bookId,
    amount: tx.amount,
    balanceAfter: tx.balanceAfter,
    reason: tx.reason as unknown as CreditReason,
    createdAt: tx.createdAt.toISOString(),
  };
}
