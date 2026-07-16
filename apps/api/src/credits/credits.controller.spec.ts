import { describe, it, expect, vi } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import type { User } from '@prisma/client';
import { CreditsController } from './credits.controller';
import type { CreditsService } from './credits.service';

const FAKE_USER = { id: 'u-1' } as User;

function createMockCreditsService(): jest.Mocked<CreditsService> {
  return {
    getBalance: vi.fn(),
    getTransactions: vi.fn(),
    deduct: vi.fn(),
    add: vi.fn(),
  } as unknown as jest.Mocked<CreditsService>;
}

describe('CreditsController.getBalance', () => {
  it('derives ownership from the authenticated user, never a request param', async () => {
    const creditsService = createMockCreditsService();
    creditsService.getBalance.mockResolvedValue({
      credits: 3,
      creditsUpdatedAt: new Date('2026-07-01T00:00:00.000Z'),
    });
    const controller = new CreditsController(creditsService);

    const result = await controller.getBalance(FAKE_USER);

    expect(creditsService.getBalance).toHaveBeenCalledWith('u-1');
    expect(result).toEqual({ balance: 3, creditsUpdatedAt: '2026-07-01T00:00:00.000Z' });
  });
});

describe('CreditsController.getTransactions', () => {
  it('delegates to creditsService with the current user, clamped limit, and no direction/cursor when omitted', async () => {
    const creditsService = createMockCreditsService();
    creditsService.getTransactions.mockResolvedValue({ items: [], nextCursor: null });
    const controller = new CreditsController(creditsService);

    const result = await controller.getTransactions(FAKE_USER, undefined, 20, undefined);

    expect(creditsService.getTransactions).toHaveBeenCalledWith('u-1', { limit: 20 });
    expect(result).toEqual({ items: [], nextCursor: null, limit: 20 });
  });

  it('clamps a limit above the maximum page size before calling the service', async () => {
    const creditsService = createMockCreditsService();
    creditsService.getTransactions.mockResolvedValue({ items: [], nextCursor: null });
    const controller = new CreditsController(creditsService);

    await controller.getTransactions(FAKE_USER, undefined, 5000, undefined);

    expect(creditsService.getTransactions).toHaveBeenCalledWith('u-1', { limit: 100 });
  });

  it('passes a valid direction through', async () => {
    const creditsService = createMockCreditsService();
    creditsService.getTransactions.mockResolvedValue({ items: [], nextCursor: null });
    const controller = new CreditsController(creditsService);

    await controller.getTransactions(FAKE_USER, undefined, 20, 'debit');

    expect(creditsService.getTransactions).toHaveBeenCalledWith('u-1', {
      limit: 20,
      direction: 'debit',
    });
  });

  it('rejects an invalid direction with 400 before calling the service', async () => {
    const creditsService = createMockCreditsService();
    const controller = new CreditsController(creditsService);

    await expect(
      controller.getTransactions(FAKE_USER, undefined, 20, 'not-a-direction'),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(creditsService.getTransactions).not.toHaveBeenCalled();
  });
});
