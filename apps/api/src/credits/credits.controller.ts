import {
  BadRequestException,
  Controller,
  DefaultValuePipe,
  Get,
  ParseIntPipe,
  ParseUUIDPipe,
  Query,
  UseGuards,
} from '@nestjs/common';
import type { User } from '@prisma/client';
import {
  DEFAULT_CREDIT_TRANSACTIONS_PAGE_SIZE,
  MAX_CREDIT_TRANSACTIONS_PAGE_SIZE,
  type CreditBalanceDto,
  type CreditTransactionDirection,
  type CreditTransactionsPageDto,
} from '@book/types';
import { AuthModeGuard } from '../auth/auth-mode.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { CreditsService } from './credits.service';
import { toCreditBalanceDto, toCreditTransactionDto } from './credits.mapper';

function parseDirection(value: string | undefined): CreditTransactionDirection | undefined {
  if (value === undefined) return undefined;
  if (value === 'debit' || value === 'credit') return value;
  throw new BadRequestException('direction must be "debit" or "credit"');
}

/**
 * Ownership is derived exclusively from the authenticated user
 * (@CurrentUser) — neither endpoint accepts a userId from the query or body,
 * so a caller can never read another user's balance or ledger.
 */
@UseGuards(AuthModeGuard)
@Controller('credits')
export class CreditsController {
  constructor(private readonly creditsService: CreditsService) {}

  @Get('balance')
  async getBalance(@CurrentUser() user: User): Promise<CreditBalanceDto> {
    const balance = await this.creditsService.getBalance(user.id);
    return toCreditBalanceDto(balance);
  }

  @Get('transactions')
  async getTransactions(
    @CurrentUser() user: User,
    @Query('cursor', new ParseUUIDPipe({ version: '4', optional: true }))
    cursor: string | undefined,
    @Query('limit', new DefaultValuePipe(DEFAULT_CREDIT_TRANSACTIONS_PAGE_SIZE), ParseIntPipe)
    limit: number,
    @Query('direction') direction: string | undefined,
  ): Promise<CreditTransactionsPageDto> {
    const boundedLimit = Math.min(Math.max(limit, 1), MAX_CREDIT_TRANSACTIONS_PAGE_SIZE);
    const parsedDirection = parseDirection(direction);
    const result = await this.creditsService.getTransactions(user.id, {
      limit: boundedLimit,
      ...(cursor ? { cursor } : {}),
      ...(parsedDirection ? { direction: parsedDirection } : {}),
    });
    return {
      items: result.items.map(toCreditTransactionDto),
      nextCursor: result.nextCursor,
      limit: boundedLimit,
    };
  }
}
