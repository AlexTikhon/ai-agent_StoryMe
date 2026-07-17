import { Body, Controller, Get, Headers, HttpCode, Param, Post, UseGuards } from '@nestjs/common';
import type { User } from '@prisma/client';
import type {
  CheckoutGrantStatusDto,
  CheckoutSessionDto,
  CreditPackageCatalogDto,
} from '@book/types';
import { AuthModeGuard } from '../auth/auth-mode.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { RequireVerifiedEmailGuard } from '../auth/require-verified-email.guard';
import { RateLimit } from '../rate-limit/rate-limit.decorator';
import { UserRateLimitGuard } from '../rate-limit/user-rate-limit.guard';
import { BillingService } from './billing.service';
import { CreateCheckoutDto } from './dto/create-checkout.dto';

/** Authenticated billing endpoints — see BillingWebhookController for the public Stripe webhook, which must never sit behind these guards. */
@UseGuards(AuthModeGuard, UserRateLimitGuard)
@Controller('billing')
export class BillingController {
  constructor(private readonly billingService: BillingService) {}

  /**
   * Creates a Stripe Checkout Session for a server-owned credit package —
   * never grants credits itself (the checkout.session.completed webhook
   * does, once Stripe confirms payment). See apps/api/docs/credits.md,
   * "Phase E3".
   */
  @Post('checkout')
  @HttpCode(200)
  @UseGuards(RequireVerifiedEmailGuard)
  @RateLimit({
    windowMsEnvKey: 'BILLING_CHECKOUT_RATE_LIMIT_WINDOW_MS',
    maxAttemptsEnvKey: 'BILLING_CHECKOUT_RATE_LIMIT_MAX_ATTEMPTS',
  })
  checkout(
    @CurrentUser() user: User,
    @Body() dto: CreateCheckoutDto,
    @Headers('idempotency-key') idempotencyKeyHeader: string | undefined,
  ): Promise<CheckoutSessionDto> {
    return this.billingService.createCheckoutSession(user, dto.packageId, idempotencyKeyHeader);
  }

  /** Server-owned package catalog for the frontend — see BillingService.getPackageCatalog for what it never exposes (Price IDs, secrets, webhook config). */
  @Get('packages')
  getPackages(): CreditPackageCatalogDto {
    return this.billingService.getPackageCatalog();
  }

  /**
   * Reports durable local grant state for a Checkout Session — safe for a
   * frontend to poll (see BillingService.getCheckoutStatus): never a Stripe
   * call, never a mutation, never distinguishes an unowned session from an
   * unknown one.
   */
  @Get('checkout/:sessionId/status')
  @RateLimit({
    windowMsEnvKey: 'BILLING_CHECKOUT_STATUS_RATE_LIMIT_WINDOW_MS',
    maxAttemptsEnvKey: 'BILLING_CHECKOUT_STATUS_RATE_LIMIT_MAX_ATTEMPTS',
  })
  getCheckoutStatus(
    @CurrentUser() user: User,
    @Param('sessionId') sessionId: string,
  ): Promise<CheckoutGrantStatusDto> {
    return this.billingService.getCheckoutStatus(user, sessionId);
  }
}
