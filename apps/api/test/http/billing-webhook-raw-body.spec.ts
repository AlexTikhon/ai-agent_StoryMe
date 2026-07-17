import 'reflect-metadata';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Body, Controller, Module, Post, ValidationPipe } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { IsInt, IsString } from 'class-validator';
import Stripe from 'stripe';
import { BillingWebhookController } from '../../src/billing/billing-webhook.controller';
import { BillingService } from '../../src/billing/billing.service';
import { BillingConfigService } from '../../src/billing/billing-config.service';
import { STRIPE_CLIENT_TOKEN } from '../../src/billing/stripe-client.provider';
import { PrismaService } from '../../src/database/prisma.service';
import { CreditsService } from '../../src/credits/credits.service';

/**
 * Proves two things about the real Nest/Express HTTP stack (main.ts's
 * `rawBody: true` bootstrap option), not just BillingService's own logic in
 * isolation:
 *
 * 1. POST /billing/webhook's signature verification runs against the exact,
 *    unmodified raw request bytes — not a re-serialization of the parsed
 *    JSON body, which could silently differ (whitespace, key order) from
 *    what Stripe actually signed.
 * 2. Enabling `rawBody: true` doesn't break ordinary JSON body
 *    parsing/validation for every other endpoint.
 *
 * Uses a real `Stripe` instance and its official `webhooks.constructEvent` /
 * `webhooks.generateTestHeaderString` test-signature helper — both pure
 * local HMAC operations, no network call and no real Stripe credentials.
 * PrismaService/CreditsService are inert stand-ins: the event type used
 * below (`payment_intent.succeeded`) is intentionally not
 * `checkout.session.completed`, so BillingService never reaches the code
 * that would call either.
 */
const WEBHOOK_SECRET = 'whsec_test_raw_body_secret';

class EchoDto {
  @IsString()
  name!: string;

  @IsInt()
  count!: number;
}

@Controller('echo')
class EchoController {
  @Post()
  echo(@Body() dto: EchoDto): EchoDto {
    return dto;
  }
}

/**
 * BillingService and BillingWebhookController both declare their
 * cross-class constructor dependencies with an explicit `@Inject(Token)`
 * rather than relying purely on Nest's automatic constructor-type
 * reflection (`design:paramtypes`) — this test suite runs under Vitest's
 * esbuild-based TS transform, which (unlike the real `tsc` build main.ts
 * runs under) doesn't emit that metadata, so plain type-based autowiring
 * silently resolves to `undefined` here. Every other spec in this repo
 * sidesteps the same gap by constructing services with a plain `new`
 * instead of Nest's DI container; explicit `@Inject()` is the equivalent
 * fix for a real `NestFactory.create` bootstrap, and is a no-op change for
 * the real (tsc-built) production app.
 */
@Module({
  controllers: [BillingWebhookController, EchoController],
  providers: [
    BillingService,
    {
      provide: BillingConfigService,
      useValue: {
        isEnabled: () => true,
        getWebhookSecret: () => WEBHOOK_SECRET,
        getWebAppUrl: () => 'https://app.storyme.example',
        getPackage: () => undefined,
        getAllPackages: () => [],
      },
    },
    { provide: STRIPE_CLIENT_TOKEN, useValue: new Stripe('sk_test_dummy_never_called') },
    { provide: PrismaService, useValue: { user: { findUnique: () => Promise.resolve(null) } } },
    {
      provide: CreditsService,
      useValue: { add: () => Promise.reject(new Error('must not be called')) },
    },
  ],
})
class RawBodyTestModule {}

describe('Raw body preservation through the real Nest HTTP stack', () => {
  let app: INestApplication;
  let baseUrl: string;

  beforeAll(async () => {
    app = await NestFactory.create<NestExpressApplication>(RawBodyTestModule, {
      logger: false,
      rawBody: true,
    });
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.listen(0);
    baseUrl = await app.getUrl();
  });

  afterAll(async () => {
    await app.close();
  });

  function sign(payload: string): string {
    return Stripe.webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET });
  }

  it('accepts a genuinely signed payload and verifies it against the exact raw bytes, including non-canonical JSON formatting', async () => {
    // Deliberately pretty-printed with extra whitespace/newlines — if Nest
    // were reconstructing the body via JSON.stringify(req.body) instead of
    // handing constructEvent the true raw bytes, this exact-byte signature
    // would fail to verify even though the parsed object is equivalent.
    const payload = JSON.stringify(
      { id: 'evt_raw_body_test', type: 'payment_intent.succeeded', data: { object: {} } },
      null,
      2,
    );
    const signature = sign(payload);

    const res = await fetch(`${baseUrl}/billing/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Stripe-Signature': signature },
      body: payload,
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true });
  });

  it('rejects when the raw bytes received differ from what was signed (tampered in transit)', async () => {
    const payload = JSON.stringify({
      id: 'evt_tampered',
      type: 'payment_intent.succeeded',
      data: { object: {} },
    });
    const signature = sign(payload);
    const tamperedPayload = payload.replace('evt_tampered', 'evt_tampered_x');

    const res = await fetch(`${baseUrl}/billing/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Stripe-Signature': signature },
      body: tamperedPayload,
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe('INVALID_SIGNATURE');
  });

  it('rejects a request with no Stripe-Signature header at all', async () => {
    const payload = JSON.stringify({
      id: 'evt_no_sig',
      type: 'payment_intent.succeeded',
      data: { object: {} },
    });

    const res = await fetch(`${baseUrl}/billing/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload,
    });

    expect(res.status).toBe(400);
  });

  it('still parses ordinary JSON request bodies correctly on a normal endpoint with rawBody enabled', async () => {
    const res = await fetch(`${baseUrl}/echo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'storyme', count: 3 }),
    });

    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ name: 'storyme', count: 3 });
  });

  it('still rejects syntactically invalid JSON on a normal endpoint — the json bodyParser itself is unaffected by rawBody:true', async () => {
    const res = await fetch(`${baseUrl}/echo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{ this is not valid json',
    });

    expect(res.status).toBe(400);
  });
});
