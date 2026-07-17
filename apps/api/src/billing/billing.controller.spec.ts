import { describe, it, expect, vi } from 'vitest';
import type { User } from '@prisma/client';
import { BillingController } from './billing.controller';
import type { BillingService } from './billing.service';

const FAKE_USER = { id: 'user-1' } as User;

function createMockBillingService(): jest.Mocked<BillingService> {
  return {
    createCheckoutSession: vi.fn(),
    getPackageCatalog: vi.fn(),
    getCheckoutStatus: vi.fn(),
  } as unknown as jest.Mocked<BillingService>;
}

describe('BillingController.getPackages', () => {
  it('delegates to BillingService.getPackageCatalog with no arguments', () => {
    const billingService = createMockBillingService();
    billingService.getPackageCatalog.mockReturnValue({
      checkoutEnabled: true,
      packages: [{ id: 'starter', credits: 10 }],
    });
    const controller = new BillingController(billingService);

    const result = controller.getPackages();

    expect(billingService.getPackageCatalog).toHaveBeenCalledWith();
    expect(result).toEqual({ checkoutEnabled: true, packages: [{ id: 'starter', credits: 10 }] });
  });
});

describe('BillingController.getCheckoutStatus', () => {
  it('derives ownership from the authenticated user and forwards the path param verbatim', async () => {
    const billingService = createMockBillingService();
    billingService.getCheckoutStatus.mockResolvedValue({ status: 'pending' });
    const controller = new BillingController(billingService);

    const result = await controller.getCheckoutStatus(FAKE_USER, 'cs_test_123');

    expect(billingService.getCheckoutStatus).toHaveBeenCalledWith(FAKE_USER, 'cs_test_123');
    expect(result).toEqual({ status: 'pending' });
  });
});
