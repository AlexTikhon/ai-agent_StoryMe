import { Inject, Injectable, Logger } from '@nestjs/common';
import type { User } from '@prisma/client';
import Stripe from 'stripe';
import type { CheckoutSessionDto } from '@book/types';
import { PrismaService } from '../database/prisma.service';
import { CreditsService } from '../credits/credits.service';
import { BillingConfigService } from './billing-config.service';
import { STRIPE_CLIENT_TOKEN } from './stripe-client.provider';
import { buildCheckoutIdempotencyKey } from './checkout-idempotency-key';
import {
  billingDisabledException,
  checkoutUnavailableException,
  invalidPackageException,
  invalidSignatureException,
} from './billing-errors';

/** Deterministic, DB-enforced dedupe key for granting credits for one Checkout Session — never derived from the delivered event's own id, so duplicate deliveries, concurrent handlers, and differently-identified events for the same session all converge on exactly one grant. See apps/api/docs/credits.md, "Phase E3". */
export function checkoutSessionGrantIdempotencyKey(sessionId: string): string {
  return `stripe:checkout:${sessionId}`;
}

const RELEVANT_EVENT_TYPE = 'checkout.session.completed';

/**
 * Owns Stripe Checkout session creation and the checkout.session.completed
 * webhook's credit-grant logic. Every credit mutation goes through
 * CreditsService — this class never writes User.credits or
 * CreditTransaction directly. See apps/api/docs/credits.md, "Phase E3".
 */
@Injectable()
export class BillingService {
  private readonly logger = new Logger(BillingService.name);

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(CreditsService) private readonly creditsService: CreditsService,
    @Inject(BillingConfigService) private readonly billingConfig: BillingConfigService,
    @Inject(STRIPE_CLIENT_TOKEN) private readonly stripeClient: Stripe | null,
  ) {}

  /**
   * Creates a Stripe-hosted Checkout Session for exactly one server-owned
   * package at quantity 1 — never grants credits itself (that only happens
   * once the webhook observes a paid session). Fails closed with
   * BILLING_DISABLED before ever constructing a Stripe request when billing
   * isn't enabled/configured.
   */
  async createCheckoutSession(
    user: User,
    packageId: string,
    idempotencyKeyHeader: string | undefined,
  ): Promise<CheckoutSessionDto> {
    if (!this.billingConfig.isEnabled() || !this.stripeClient) {
      throw billingDisabledException();
    }

    const pkg = this.billingConfig.getPackage(packageId);
    if (!pkg) {
      throw invalidPackageException();
    }

    const idempotencyKey = buildCheckoutIdempotencyKey(user.id, idempotencyKeyHeader);
    const webAppUrl = this.billingConfig.getWebAppUrl();

    let session: Stripe.Checkout.Session;
    try {
      session = await this.stripeClient.checkout.sessions.create(
        {
          mode: 'payment',
          line_items: [{ price: pkg.priceId, quantity: 1 }],
          success_url: `${webAppUrl}/billing/success?session_id={CHECKOUT_SESSION_ID}`,
          cancel_url: `${webAppUrl}/billing/cancel`,
          client_reference_id: user.id,
          // Durable metadata read back by the webhook — only the user id and
          // the stable package id, never a Price ID, amount, or currency.
          metadata: { userId: user.id, packageId: pkg.id },
        },
        { idempotencyKey },
      );
    } catch {
      this.logger.error(`Checkout session creation failed for user ${user.id}, package ${pkg.id}`);
      throw checkoutUnavailableException();
    }

    if (!session.url) {
      this.logger.error(`Checkout session ${session.id} has no hosted URL`);
      throw checkoutUnavailableException();
    }

    this.logger.log(
      `Created checkout session ${session.id} for user ${user.id}, package ${pkg.id}`,
    );
    return { sessionId: session.id, url: session.url };
  }

  /**
   * Verifies the Stripe-Signature header against the raw request body and
   * processes the event. Only checkout.session.completed triggers a credit
   * grant; every other event type (including other events Stripe delivers
   * to the same endpoint) returns normally with no mutation. Throws for a
   * missing/invalid signature (400) or when the grant itself fails (lets
   * the underlying error propagate so the controller returns a non-2xx and
   * Stripe retries — see grantCreditsForCheckoutSession).
   */
  async handleWebhookEvent(
    rawBody: Buffer,
    signatureHeader: string | string[] | undefined,
  ): Promise<void> {
    const secret = this.billingConfig.getWebhookSecret();
    const signature = Array.isArray(signatureHeader) ? signatureHeader[0] : signatureHeader;

    if (!this.stripeClient || !secret || !signature) {
      throw invalidSignatureException();
    }

    let event: Stripe.Event;
    try {
      event = this.stripeClient.webhooks.constructEvent(rawBody, signature, secret);
    } catch {
      throw invalidSignatureException();
    }

    if (event.type !== RELEVANT_EVENT_TYPE) {
      this.logger.log(`Ignoring Stripe event ${event.id} (${event.type})`);
      return;
    }

    const session = event.data.object as Stripe.Checkout.Session;
    await this.grantCreditsForCheckoutSession(session);
  }

  /**
   * Verifies every condition in apps/api/docs/credits.md's "Phase E3
   * payment verification" list before granting anything: payment mode,
   * payment status, that the metadata-referenced user still exists, that
   * the metadata packageId maps to the server catalog, and that the
   * session's actual Stripe-side line items (re-fetched, not trusted from
   * event/webhook metadata) match that package's Price ID and quantity.
   * Any check that fails is treated as "nothing to grant" and returns
   * normally (2xx, no mutation) — only a genuine Stripe/DB failure while
   * verifying or granting propagates as a thrown error.
   */
  private async grantCreditsForCheckoutSession(session: Stripe.Checkout.Session): Promise<void> {
    const sessionId = session.id;

    if (session.mode !== 'payment') {
      this.logger.log(`Checkout session ${sessionId}: not a payment-mode session, skipping`);
      return;
    }
    if (session.payment_status !== 'paid') {
      this.logger.log(
        `Checkout session ${sessionId}: payment_status=${session.payment_status}, skipping`,
      );
      return;
    }

    const userId = session.metadata?.['userId'];
    const packageId = session.metadata?.['packageId'];
    if (!userId || !packageId) {
      this.logger.warn(
        `Checkout session ${sessionId}: missing userId/packageId metadata, skipping`,
      );
      return;
    }

    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
    if (!user) {
      this.logger.warn(`Checkout session ${sessionId}: referenced user no longer exists, skipping`);
      return;
    }

    const pkg = this.billingConfig.getPackage(packageId);
    if (!pkg) {
      this.logger.warn(`Checkout session ${sessionId}: unknown package ${packageId}, skipping`);
      return;
    }

    // Never trust event/webhook metadata for the purchased Price ID or
    // quantity — re-fetch the session's actual line items from Stripe.
    const fullSession = await this.stripeClient!.checkout.sessions.retrieve(sessionId, {
      expand: ['line_items'],
    });
    const lineItems = fullSession.line_items?.data ?? [];
    const matchesPackage =
      lineItems.length === 1 &&
      lineItems[0]?.price?.id === pkg.priceId &&
      lineItems[0]?.quantity === 1;
    if (!matchesPackage) {
      this.logger.warn(
        `Checkout session ${sessionId}: line items do not match package ${packageId}, skipping`,
      );
      return;
    }

    await this.creditsService.add({
      userId,
      amount: pkg.credits,
      reason: 'purchase',
      stripePaymentId: sessionId,
      idempotencyKey: checkoutSessionGrantIdempotencyKey(sessionId),
    });

    this.logger.log(
      `Granted ${pkg.credits} credits to user ${userId} for checkout session ${sessionId} (package ${packageId})`,
    );
  }
}
