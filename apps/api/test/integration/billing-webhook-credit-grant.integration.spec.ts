import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { PrismaService } from '../../src/database/prisma.service';
import { CreditsService } from '../../src/credits/credits.service';
import {
  BillingService,
  checkoutSessionGrantIdempotencyKey,
} from '../../src/billing/billing.service';
import type {
  BillingConfigService,
  ResolvedCreditPackage,
} from '../../src/billing/billing-config.service';

/**
 * Durable integration coverage against a real Postgres (see
 * vitest.integration.config.ts) for Phase E3's exactly-once credit grant —
 * exercises the actual production method, BillingService.handleWebhookEvent,
 * backed by the real CreditsService/PrismaService (the same code path
 * apps/api/docs/credits.md documents), not a hand-copied mirror of the
 * dedup logic.
 *
 * Stripe itself is stubbed (constructEvent just parses the raw JSON we
 * signed as our own test fixture; checkout.sessions.retrieve resolves a
 * fixed line-items payload) — no real network call and no real Stripe
 * credentials, consistent with every other Stripe-touching test in this
 * repo. Signature-verification-against-real-bytes is covered separately by
 * test/http/billing-webhook-raw-body.spec.ts; this suite is scoped to what
 * only a real Postgres can prove: atomicity, concurrency, and dedup of the
 * actual credit mutation.
 */
const STARTER: ResolvedCreditPackage = {
  id: 'starter',
  credits: 10,
  priceId: 'price_starter_test',
};

function fakeBillingConfig(): BillingConfigService {
  return {
    isEnabled: () => true,
    getWebhookSecret: () => 'whsec_test',
    getWebAppUrl: () => 'https://app.storyme.example',
    getPackage: (id: string) => (id === STARTER.id ? STARTER : undefined),
    getAllPackages: () => [STARTER],
  } as unknown as BillingConfigService;
}

function fakeStripeClient() {
  return {
    webhooks: {
      constructEvent: (raw: Buffer) => JSON.parse(raw.toString('utf8')) as unknown,
    },
    checkout: {
      sessions: {
        retrieve: vi.fn().mockResolvedValue({
          line_items: { data: [{ price: { id: STARTER.priceId }, quantity: 1 }] },
        }),
      },
    },
  };
}

function checkoutCompletedPayload(sessionId: string, userId: string, eventId?: string): string {
  return JSON.stringify({
    id: eventId ?? `evt_${randomUUID()}`,
    type: 'checkout.session.completed',
    data: {
      object: {
        id: sessionId,
        mode: 'payment',
        payment_status: 'paid',
        metadata: { userId, packageId: STARTER.id },
      },
    },
  });
}

describe('Billing webhook credit grant (Phase E3, real Postgres)', () => {
  const prisma = new PrismaService();
  const creditsService = new CreditsService(prisma);
  const userIds: string[] = [];

  beforeAll(async () => {
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (userIds.length > 0) {
      // CreditTransaction.user has no onDelete: Cascade — delete ledger rows
      // before the user row they reference (same convention as
      // credits.integration.spec.ts).
      await prisma.creditTransaction.deleteMany({ where: { userId: { in: userIds } } });
      await prisma.user.deleteMany({ where: { id: { in: userIds } } });
      userIds.length = 0;
    }
  });

  async function createUser(): Promise<string> {
    const user = await prisma.user.create({
      data: { email: `billing-e3-${randomUUID()}@example.test`, credits: 0 },
    });
    userIds.push(user.id);
    return user.id;
  }

  function buildService(stripeClient: ReturnType<typeof fakeStripeClient>): BillingService {
    return new BillingService(prisma, creditsService, fakeBillingConfig(), stripeClient as never);
  }

  it('a paid session atomically updates User.credits and creates exactly one purchase ledger row', async () => {
    const userId = await createUser();
    const sessionId = `cs_test_${randomUUID()}`;
    const service = buildService(fakeStripeClient());

    await service.handleWebhookEvent(
      Buffer.from(checkoutCompletedPayload(sessionId, userId)),
      'sig',
    );

    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(user.credits).toBe(STARTER.credits);
    expect(user.creditsUpdatedAt).not.toBeNull();
    const rows = await prisma.creditTransaction.findMany({ where: { userId } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      amount: STARTER.credits,
      balanceAfter: STARTER.credits,
      reason: 'purchase',
      stripePaymentId: sessionId,
      idempotencyKey: checkoutSessionGrantIdempotencyKey(sessionId),
    });
  });

  it('two concurrent handlers for the same session produce one balance increment and one ledger row', async () => {
    const userId = await createUser();
    const sessionId = `cs_test_${randomUUID()}`;
    const service = buildService(fakeStripeClient());
    const payload = checkoutCompletedPayload(sessionId, userId);

    await Promise.all([
      service.handleWebhookEvent(Buffer.from(payload), 'sig'),
      service.handleWebhookEvent(Buffer.from(payload), 'sig'),
    ]);

    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(user.credits).toBe(STARTER.credits);
    const rows = await prisma.creditTransaction.findMany({ where: { userId } });
    expect(rows).toHaveLength(1);
  });

  it('a redelivered event id and a distinct event id for the same session both remain exactly once', async () => {
    const userId = await createUser();
    const sessionId = `cs_test_${randomUUID()}`;
    const service = buildService(fakeStripeClient());

    await service.handleWebhookEvent(
      Buffer.from(checkoutCompletedPayload(sessionId, userId, 'evt_1')),
      'sig',
    );
    // Stripe redelivering the exact same event id.
    await service.handleWebhookEvent(
      Buffer.from(checkoutCompletedPayload(sessionId, userId, 'evt_1')),
      'sig',
    );
    // A distinct event id Stripe generated for the same underlying session.
    await service.handleWebhookEvent(
      Buffer.from(checkoutCompletedPayload(sessionId, userId, 'evt_2')),
      'sig',
    );

    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(user.credits).toBe(STARTER.credits);
    const rows = await prisma.creditTransaction.findMany({ where: { userId } });
    expect(rows).toHaveLength(1);
  });

  it('a forced transient DB failure grants nothing and propagates so the webhook can be retried', async () => {
    const userId = await createUser();
    const sessionId = `cs_test_${randomUUID()}`;
    const service = buildService(fakeStripeClient());
    // Simulates a dropped connection mid-grant — the same underlying
    // CreditsService.add call BillingService always uses, just forced to
    // fail once, deterministically, without touching an unrelated unique
    // constraint (which would just exercise the intentional idempotent-dedupe
    // fast path instead of a genuine failure).
    vi.spyOn(prisma, '$transaction').mockRejectedValueOnce(
      new Error('server closed the connection unexpectedly'),
    );

    await expect(
      service.handleWebhookEvent(Buffer.from(checkoutCompletedPayload(sessionId, userId)), 'sig'),
    ).rejects.toThrow('server closed the connection unexpectedly');

    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(user.credits).toBe(0);
    const rows = await prisma.creditTransaction.findMany({ where: { userId } });
    expect(rows).toHaveLength(0);

    // A subsequent retry (Stripe's real behavior after a non-2xx) succeeds
    // and grants exactly once — the earlier failed attempt left nothing
    // behind to double-grant against.
    await service.handleWebhookEvent(
      Buffer.from(checkoutCompletedPayload(sessionId, userId)),
      'sig',
    );
    const userAfterRetry = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(userAfterRetry.credits).toBe(STARTER.credits);
    const rowsAfterRetry = await prisma.creditTransaction.findMany({ where: { userId } });
    expect(rowsAfterRetry).toHaveLength(1);
  });
});
