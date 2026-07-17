import { Controller, Headers, HttpCode, Inject, Post, Req } from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import { BillingService } from './billing.service';
import { invalidSignatureException } from './billing-errors';

/**
 * Public Stripe webhook — deliberately outside every auth guard. Stripe
 * signature verification (BillingService.handleWebhookEvent) is this
 * endpoint's only authentication. Requires `req.rawBody`, populated by
 * Nest's `rawBody: true` bootstrap option (main.ts) — see
 * apps/api/docs/credits.md, "Phase E3", for why the exact, unmodified raw
 * bytes (not the parsed/re-serialized JSON body) are required for Stripe's
 * HMAC signature to verify.
 */
@Controller('billing')
export class BillingWebhookController {
  constructor(@Inject(BillingService) private readonly billingService: BillingService) {}

  @Post('webhook')
  @HttpCode(200)
  async webhook(
    @Req() req: RawBodyRequest<Request>,
    @Headers('stripe-signature') signature: string | undefined,
  ): Promise<{ received: true }> {
    if (!req.rawBody) {
      throw invalidSignatureException();
    }
    await this.billingService.handleWebhookEvent(req.rawBody, signature);
    return { received: true };
  }
}
