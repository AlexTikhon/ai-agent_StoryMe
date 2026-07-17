import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { CreditsModule } from '../credits/credits.module';
import { BillingConfigService } from './billing-config.service';
import { BillingController } from './billing.controller';
import { BillingWebhookController } from './billing-webhook.controller';
import { BillingService } from './billing.service';
import { stripeClientProvider } from './stripe-client.provider';

@Module({
  imports: [AuthModule, CreditsModule],
  controllers: [BillingController, BillingWebhookController],
  providers: [BillingConfigService, BillingService, stripeClientProvider],
})
export class BillingModule {}
