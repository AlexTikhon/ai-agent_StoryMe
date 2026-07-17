import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HttpException } from '@nestjs/common';
import type { User } from '@prisma/client';
import { BillingService, checkoutSessionGrantIdempotencyKey } from './billing.service';
import type { BillingConfigService, ResolvedCreditPackage } from './billing-config.service';
import {
  BILLING_DISABLED_CODE,
  CHECKOUT_UNAVAILABLE_CODE,
  INVALID_PACKAGE_CODE,
  INVALID_SIGNATURE_CODE,
} from './billing-errors';
import { createMockPrisma } from '../common/test-utils/mock-prisma';

type MockPrisma = ReturnType<typeof createMockPrisma>;

function fakeUser(overrides: Partial<User> = {}): User {
  return { id: 'user-1', email: 'user-1@example.test', ...overrides } as User;
}

function fakeStripe() {
  return {
    checkout: {
      sessions: {
        create: vi.fn(),
        retrieve: vi.fn(),
      },
    },
    webhooks: {
      constructEvent: vi.fn(),
    },
  };
}

const STARTER: ResolvedCreditPackage = { id: 'starter', credits: 10, priceId: 'price_starter' };

function fakeBillingConfig(overrides: Partial<BillingConfigService> = {}): BillingConfigService {
  return {
    isEnabled: vi.fn().mockReturnValue(true),
    getWebAppUrl: vi.fn().mockReturnValue('https://app.storyme.example'),
    getWebhookSecret: vi.fn().mockReturnValue('whsec_test'),
    getPackage: vi.fn().mockReturnValue(STARTER),
    getAllPackages: vi.fn().mockReturnValue([STARTER]),
    ...overrides,
  } as unknown as BillingConfigService;
}

function checkoutCompletedEvent(sessionOverrides: Record<string, unknown> = {}) {
  return {
    id: 'evt_1',
    type: 'checkout.session.completed',
    data: {
      object: {
        id: 'cs_test_123',
        mode: 'payment',
        payment_status: 'paid',
        metadata: { userId: 'user-1', packageId: 'starter' },
        ...sessionOverrides,
      },
    },
  };
}

function matchingLineItems() {
  return { data: [{ price: { id: 'price_starter' }, quantity: 1 }] };
}

describe('BillingService', () => {
  let prisma: MockPrisma;
  let creditsService: { add: ReturnType<typeof vi.fn> };
  let stripe: ReturnType<typeof fakeStripe>;

  beforeEach(() => {
    prisma = createMockPrisma();
    creditsService = { add: vi.fn().mockResolvedValue({ id: 'tx-1' }) };
    stripe = fakeStripe();
  });

  function buildService(billingConfig: BillingConfigService, stripeClient: unknown = stripe) {
    return new BillingService(
      prisma as never,
      creditsService as never,
      billingConfig,
      stripeClient as never,
    );
  }

  describe('createCheckoutSession', () => {
    it('fails closed with BILLING_DISABLED and makes no Stripe call when billing is disabled (no client)', async () => {
      const service = buildService(
        fakeBillingConfig({ isEnabled: vi.fn().mockReturnValue(false) }),
        null,
      );

      await expect(
        service.createCheckoutSession(fakeUser(), 'starter', undefined),
      ).rejects.toMatchObject({
        response: expect.objectContaining({ code: BILLING_DISABLED_CODE }),
      });
      expect(stripe.checkout.sessions.create).not.toHaveBeenCalled();
    });

    it('fails closed even when a Stripe client exists but isEnabled() is false', async () => {
      const service = buildService(
        fakeBillingConfig({ isEnabled: vi.fn().mockReturnValue(false) }),
      );

      await expect(service.createCheckoutSession(fakeUser(), 'starter', undefined)).rejects.toThrow(
        HttpException,
      );
      expect(stripe.checkout.sessions.create).not.toHaveBeenCalled();
    });

    it('rejects an unknown package id with INVALID_PACKAGE and makes no Stripe call', async () => {
      const service = buildService(
        fakeBillingConfig({ getPackage: vi.fn().mockReturnValue(undefined) }),
      );

      await expect(
        service.createCheckoutSession(fakeUser(), 'enterprise', undefined),
      ).rejects.toMatchObject({
        response: expect.objectContaining({ code: INVALID_PACKAGE_CODE }),
      });
      expect(stripe.checkout.sessions.create).not.toHaveBeenCalled();
    });

    it('creates a payment-mode session using only the server-resolved Price ID/quantity and minimal metadata', async () => {
      stripe.checkout.sessions.create.mockResolvedValue({
        id: 'cs_test_123',
        url: 'https://checkout.stripe.com/c/pay/cs_test_123',
      });
      const service = buildService(fakeBillingConfig());

      const result = await service.createCheckoutSession(
        fakeUser({ id: 'user-1' }),
        'starter',
        undefined,
      );

      expect(result).toEqual({
        sessionId: 'cs_test_123',
        url: 'https://checkout.stripe.com/c/pay/cs_test_123',
      });
      expect(stripe.checkout.sessions.create).toHaveBeenCalledTimes(1);
      const [params] = stripe.checkout.sessions.create.mock.calls[0] as [Record<string, unknown>];
      expect(params).toMatchObject({
        mode: 'payment',
        line_items: [{ price: 'price_starter', quantity: 1 }],
        metadata: { userId: 'user-1', packageId: 'starter' },
      });
      // Never a client-controlled amount/currency/Price ID anywhere in the request.
      expect(JSON.stringify(params)).not.toMatch(/amount|currency/i);
    });

    it('scopes the Stripe idempotency key by user id, so two users echoing the same header value get different keys', async () => {
      stripe.checkout.sessions.create.mockResolvedValue({
        id: 'cs_a',
        url: 'https://checkout.stripe.com/a',
      });
      const service = buildService(fakeBillingConfig());

      await service.createCheckoutSession(fakeUser({ id: 'user-a' }), 'starter', 'shared-header');
      await service.createCheckoutSession(fakeUser({ id: 'user-b' }), 'starter', 'shared-header');

      const [, optionsA] = stripe.checkout.sessions.create.mock.calls[0] as [
        unknown,
        { idempotencyKey: string },
      ];
      const [, optionsB] = stripe.checkout.sessions.create.mock.calls[1] as [
        unknown,
        { idempotencyKey: string },
      ];
      expect(optionsA.idempotencyKey).not.toBe(optionsB.idempotencyKey);
      expect(optionsA.idempotencyKey).toContain('user-a');
      expect(optionsB.idempotencyKey).toContain('user-b');
    });

    it('surfaces CHECKOUT_UNAVAILABLE when Stripe rejects the request', async () => {
      stripe.checkout.sessions.create.mockRejectedValue(new Error('stripe down'));
      const service = buildService(fakeBillingConfig());

      await expect(
        service.createCheckoutSession(fakeUser(), 'starter', undefined),
      ).rejects.toMatchObject({
        response: expect.objectContaining({ code: CHECKOUT_UNAVAILABLE_CODE }),
      });
    });

    it('surfaces CHECKOUT_UNAVAILABLE when Stripe returns a session with no hosted URL', async () => {
      stripe.checkout.sessions.create.mockResolvedValue({ id: 'cs_test_123', url: null });
      const service = buildService(fakeBillingConfig());

      await expect(
        service.createCheckoutSession(fakeUser(), 'starter', undefined),
      ).rejects.toMatchObject({
        response: expect.objectContaining({ code: CHECKOUT_UNAVAILABLE_CODE }),
      });
    });
  });

  describe('handleWebhookEvent — signature verification', () => {
    it('rejects with INVALID_SIGNATURE and grants nothing when the signature header is missing', async () => {
      const service = buildService(fakeBillingConfig());

      await expect(service.handleWebhookEvent(Buffer.from('{}'), undefined)).rejects.toMatchObject({
        response: expect.objectContaining({ code: INVALID_SIGNATURE_CODE }),
      });
      expect(stripe.webhooks.constructEvent).not.toHaveBeenCalled();
      expect(creditsService.add).not.toHaveBeenCalled();
    });

    it('rejects with INVALID_SIGNATURE and grants nothing when Stripe rejects the signature', async () => {
      stripe.webhooks.constructEvent.mockImplementation(() => {
        throw new Error('No signatures found matching the expected signature for payload');
      });
      const service = buildService(fakeBillingConfig());

      await expect(
        service.handleWebhookEvent(Buffer.from('{}'), 'bad-signature'),
      ).rejects.toMatchObject({
        response: expect.objectContaining({ code: INVALID_SIGNATURE_CODE }),
      });
      expect(creditsService.add).not.toHaveBeenCalled();
    });

    it('rejects when billing is disabled (no Stripe client), never attempting verification', async () => {
      const service = buildService(
        fakeBillingConfig({ isEnabled: vi.fn().mockReturnValue(false) }),
        null,
      );

      await expect(service.handleWebhookEvent(Buffer.from('{}'), 'sig')).rejects.toMatchObject({
        response: expect.objectContaining({ code: INVALID_SIGNATURE_CODE }),
      });
    });
  });

  describe('handleWebhookEvent — event routing and verification', () => {
    it('returns normally and grants nothing for an event type other than checkout.session.completed', async () => {
      stripe.webhooks.constructEvent.mockReturnValue({
        id: 'evt_1',
        type: 'payment_intent.succeeded',
        data: { object: {} },
      });
      const service = buildService(fakeBillingConfig());

      await expect(service.handleWebhookEvent(Buffer.from('{}'), 'sig')).resolves.toBeUndefined();
      expect(creditsService.add).not.toHaveBeenCalled();
    });

    it('grants nothing for a non-payment-mode session (e.g. subscription)', async () => {
      stripe.webhooks.constructEvent.mockReturnValue(
        checkoutCompletedEvent({ mode: 'subscription' }),
      );
      const service = buildService(fakeBillingConfig());

      await service.handleWebhookEvent(Buffer.from('{}'), 'sig');

      expect(stripe.checkout.sessions.retrieve).not.toHaveBeenCalled();
      expect(creditsService.add).not.toHaveBeenCalled();
    });

    it('grants nothing for an unpaid session', async () => {
      stripe.webhooks.constructEvent.mockReturnValue(
        checkoutCompletedEvent({ payment_status: 'unpaid' }),
      );
      const service = buildService(fakeBillingConfig());

      await service.handleWebhookEvent(Buffer.from('{}'), 'sig');

      expect(stripe.checkout.sessions.retrieve).not.toHaveBeenCalled();
      expect(creditsService.add).not.toHaveBeenCalled();
    });

    it('grants nothing when metadata references an unknown user', async () => {
      stripe.webhooks.constructEvent.mockReturnValue(checkoutCompletedEvent());
      prisma.user.findUnique.mockResolvedValue(null);
      const service = buildService(fakeBillingConfig());

      await service.handleWebhookEvent(Buffer.from('{}'), 'sig');

      expect(creditsService.add).not.toHaveBeenCalled();
    });

    it('grants nothing when metadata references an unknown package', async () => {
      stripe.webhooks.constructEvent.mockReturnValue(
        checkoutCompletedEvent({ metadata: { userId: 'user-1', packageId: 'enterprise' } }),
      );
      prisma.user.findUnique.mockResolvedValue({ id: 'user-1' });
      const service = buildService(
        fakeBillingConfig({ getPackage: vi.fn().mockReturnValue(undefined) }),
      );

      await service.handleWebhookEvent(Buffer.from('{}'), 'sig');

      expect(creditsService.add).not.toHaveBeenCalled();
    });

    it('grants nothing when the session metadata is missing userId/packageId', async () => {
      stripe.webhooks.constructEvent.mockReturnValue(checkoutCompletedEvent({ metadata: {} }));
      const service = buildService(fakeBillingConfig());

      await service.handleWebhookEvent(Buffer.from('{}'), 'sig');

      expect(prisma.user.findUnique).not.toHaveBeenCalled();
      expect(creditsService.add).not.toHaveBeenCalled();
    });

    it('grants nothing when the Stripe-side Price ID does not match the package', async () => {
      stripe.webhooks.constructEvent.mockReturnValue(checkoutCompletedEvent());
      prisma.user.findUnique.mockResolvedValue({ id: 'user-1' });
      stripe.checkout.sessions.retrieve.mockResolvedValue({
        line_items: { data: [{ price: { id: 'price_other' }, quantity: 1 }] },
      });
      const service = buildService(fakeBillingConfig());

      await service.handleWebhookEvent(Buffer.from('{}'), 'sig');

      expect(creditsService.add).not.toHaveBeenCalled();
    });

    it('grants nothing when the Stripe-side quantity does not match (never trusts a client/webhook-supplied amount)', async () => {
      stripe.webhooks.constructEvent.mockReturnValue(checkoutCompletedEvent());
      prisma.user.findUnique.mockResolvedValue({ id: 'user-1' });
      stripe.checkout.sessions.retrieve.mockResolvedValue({
        line_items: { data: [{ price: { id: 'price_starter' }, quantity: 5 }] },
      });
      const service = buildService(fakeBillingConfig());

      await service.handleWebhookEvent(Buffer.from('{}'), 'sig');

      expect(creditsService.add).not.toHaveBeenCalled();
    });

    it('grants the configured credits for a fully verified paid session', async () => {
      stripe.webhooks.constructEvent.mockReturnValue(checkoutCompletedEvent());
      prisma.user.findUnique.mockResolvedValue({ id: 'user-1' });
      stripe.checkout.sessions.retrieve.mockResolvedValue({ line_items: matchingLineItems() });
      const service = buildService(fakeBillingConfig());

      await service.handleWebhookEvent(Buffer.from('{}'), 'sig');

      expect(creditsService.add).toHaveBeenCalledTimes(1);
      expect(creditsService.add).toHaveBeenCalledWith({
        userId: 'user-1',
        amount: 10,
        reason: 'purchase',
        stripePaymentId: 'cs_test_123',
        idempotencyKey: checkoutSessionGrantIdempotencyKey('cs_test_123'),
      });
    });

    it('uses the same session-derived idempotency key regardless of the delivered event id, so duplicate/differently-identified deliveries converge on one grant', async () => {
      prisma.user.findUnique.mockResolvedValue({ id: 'user-1' });
      stripe.checkout.sessions.retrieve.mockResolvedValue({ line_items: matchingLineItems() });
      const service = buildService(fakeBillingConfig());

      stripe.webhooks.constructEvent.mockReturnValueOnce({
        ...checkoutCompletedEvent(),
        id: 'evt_1',
      });
      await service.handleWebhookEvent(Buffer.from('{}'), 'sig');

      stripe.webhooks.constructEvent.mockReturnValueOnce({
        ...checkoutCompletedEvent(),
        id: 'evt_2',
      });
      await service.handleWebhookEvent(Buffer.from('{}'), 'sig');

      expect(creditsService.add).toHaveBeenCalledTimes(2);
      const [firstCall] = creditsService.add.mock.calls[0] as [{ idempotencyKey: string }];
      const [secondCall] = creditsService.add.mock.calls[1] as [{ idempotencyKey: string }];
      expect(firstCall.idempotencyKey).toBe(secondCall.idempotencyKey);
    });

    it('propagates a transient Stripe failure (line-item retrieval) so the caller can return a retriable non-2xx', async () => {
      stripe.webhooks.constructEvent.mockReturnValue(checkoutCompletedEvent());
      prisma.user.findUnique.mockResolvedValue({ id: 'user-1' });
      stripe.checkout.sessions.retrieve.mockRejectedValue(new Error('Stripe API unavailable'));
      const service = buildService(fakeBillingConfig());

      await expect(service.handleWebhookEvent(Buffer.from('{}'), 'sig')).rejects.toThrow(
        'Stripe API unavailable',
      );
    });

    it('propagates a transient DB failure from the credit grant so the caller can return a retriable non-2xx', async () => {
      stripe.webhooks.constructEvent.mockReturnValue(checkoutCompletedEvent());
      prisma.user.findUnique.mockResolvedValue({ id: 'user-1' });
      stripe.checkout.sessions.retrieve.mockResolvedValue({ line_items: matchingLineItems() });
      creditsService.add.mockRejectedValue(new Error('connection terminated'));
      const service = buildService(fakeBillingConfig());

      await expect(service.handleWebhookEvent(Buffer.from('{}'), 'sig')).rejects.toThrow(
        'connection terminated',
      );
    });
  });
});
