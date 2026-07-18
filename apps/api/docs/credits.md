# Credits

Covers the internal credit-accounting system: the ledger primitive built in
Phase E1, Phase E2's wiring of that primitive into the generation lifecycle
(scheduling-time charge, failure-time refund), Phase E3's Stripe Checkout
integration for one-time credit purchases, and Phase G1's cancellation-time
refund. **Subscription cancellation** (billing), the Stripe customer portal,
promotional codes, and pay-per-book PaymentIntents remain entirely
unimplemented — see "Not in scope" at the end of each phase's section below.
**Generation cancellation** (a user voluntarily stopping an in-progress
book) is implemented as of Phase G1 — see its own section near the end of
this document; do not confuse the two "cancellation" concepts.

## Phase E1: credit accounting foundation

`User.credits` is the canonical current balance — never derived by summing
`credit_transactions`, since existing users start with the schema-default
balance (`3`) and may have no historical ledger rows at all.
`CreditsService` (`apps/api/src/credits/credits.service.ts`) is the only code
path allowed to write it.

- **`deduct`** atomically verifies sufficient balance, decrements it, stamps
  `creditsUpdatedAt`, and inserts one negative `CreditTransaction` row with
  the exact resulting `balanceAfter` — all inside one interactive Prisma
  transaction. The balance check is a conditional `updateMany` (`WHERE id = ?
AND credits >= ?`): Postgres's row lock serializes concurrent debits
  against the same user, so a losing debit's `WHERE` re-evaluates against the
  winner's already-committed balance and correctly fails closed rather than
  racing to a negative balance.
- **`add`** atomically increments the balance (no balance guard — a
  credit/grant can't fail on balance alone) and inserts one positive ledger
  row.
- Both reject a zero/negative/non-integer `amount` before touching the DB
  (`BadRequestException`).
- An unknown `userId` raises `NotFoundException`; a real user with
  insufficient balance raises a stable `402 { code: 'INSUFFICIENT_CREDITS' }`
  (`INSUFFICIENT_CREDITS_CODE`) — the two are never confused, since the
  conditional `updateMany` matching zero rows triggers a second read to tell
  them apart.
- If the ledger insert fails for any reason (including an idempotency-key
  conflict), the whole transaction — including the balance mutation that
  already ran earlier in it — rolls back.

**Idempotency**: `credit_transactions.idempotency_key` (nullable, unique —
migration `20260716190000_phase_e1_credit_idempotency_key`) lets a caller
that must apply a mutation at most once (a future Stripe webhook redelivery,
a client-retried refund, or — since Phase E2 — a generation charge/refund)
get a DB-enforced single-insert guarantee. Deliberately not a
check-then-insert design: a pre-check read is only a fast-path (avoids the DB
round-trip for a same-process replay), but the actual guarantee is the
unique constraint itself — two genuinely concurrent calls with the same key
may both pass the balance check, but only one `CreditTransaction` insert can
win; the loser's whole transaction (including its own balance mutation)
rolls back.

**Endpoints** (`apps/api/src/credits/credits.controller.ts`, behind the
existing `AuthModeGuard`):

- `GET /api/credits/balance` → `{ balance, creditsUpdatedAt }`
- `GET /api/credits/transactions?cursor=&limit=&direction=` → cursor-paginated
  `CreditTransactionDto[]` (stable `createdAt desc, id desc` order, `limit`
  clamped to `[1, 100]`, default 20; `direction` optionally filters to
  `debit` (`amount < 0`) or `credit` (`amount > 0`))

Ownership is derived exclusively from the authenticated user
(`@CurrentUser()`) — neither endpoint accepts a `userId` from the query or
body. `CreditTransactionDto` omits `stripePaymentId`/`idempotencyKey`,
neither safe to expose to the owning user.

**Not in scope for Phase E1**: no code path deducted credits for a
generation run, no Stripe dependency, checkout flow, webhook handler, or
subscription/refund logic. Closed by Phase E2 below (generation charging and
refunds only — Stripe itself is still unimplemented).

## Phase E2: generation credit charging and refunds

Wires the Phase E1 primitive into the generation lifecycle. Business policy:

- Every newly created `GenerationRun` costs exactly `GENERATION_CREDIT_COST`
  (`1`) credit — initial generation, retry, and full regeneration each
  create a new run and therefore each cost 1 credit independently.
- A terminally failed run receives exactly one compensating refund. A
  successful run is never refunded.
- A retry after a refunded failure creates a new run, is charged again, and
  is independently refundable if it, too, fails.
- `partial`/`cancelled` run outcomes are out of scope — no code path
  produces them yet (see the README's "What it does not do yet").

**Credits are charged the moment a run is durably scheduled, not when
generation completes.** `POST /books/:id/generate`,
`POST /books/:id/retry-generation`, and `POST /books/:id/regenerate` all
return the stable `402 { code: 'INSUFFICIENT_CREDITS' }` error (the same
shape Phase E1 defined) if the user's balance is insufficient at the moment
of scheduling — before any story/image generation is attempted.

### Scheduling atomicity

`BooksService.createRunAndSchedule` (private, invoked by `startGeneration`/
`retryGeneration`/`regenerateBook`) now does five things inside **one**
Prisma transaction: create the `GenerationRun`, deduct one credit via
`CreditsService.deductInTransaction`, create the negative
`CreditTransaction`, transition the `Book` to `char_build`, and create the
`OutboxEvent`. If the deduction throws `INSUFFICIENT_CREDITS` (or anything
else), the entire transaction rolls back — no run, no `Book` transition, no
outbox event, no ledger row survive. The existing per-book
DB-level partial-unique-index guard (`generation_runs_one_active_per_book`)
still resolves a racing/duplicate scheduling request the same way it always
has: only the winner's `GenerationRun` insert commits, so only the winner
ever reaches the credit deduction — a loser can never charge without first
successfully creating and owning its own run.

### Deterministic idempotency

Both generation-owned credit mutations use a key derived from the durable
`GenerationRun` id, never a client-supplied value:

- `generation:${runId}:charge` — the scheduling-time debit.
- `generation:${runId}:refund` — the failure-time compensating credit.

Since a run's id is minted once, inside the very same transaction that
charges it, these keys are stable for that run's entire lifetime. Internal
callers never accept or expose an idempotency key from the outside —
`CreditTransactionDto` still omits `idempotencyKey` from every API response,
same as Phase E1.

### Refund atomicity

`GenerationRunCoordinator.runFencedTerminalTransition` — the single choke
point every terminal `GenerationRun`/`Book` transition in this codebase goes
through (`completeRun`, `failInvalidSnapshot`, `failAbandoned`) — now
optionally performs a refund as the last step of its existing fenced
transaction, gated on a `refundOnApply` flag:

- `completeRun` sets it whenever `outcome.status !== 'complete'` (i.e. every
  failure the pipeline itself reports).
- `failInvalidSnapshot` and `failAbandoned` always set it — both paths are
  unconditionally failures (a permanently malformed `input_snapshot`, BullMQ
  retry exhaustion, or abandoned/stale-run recovery).

The refund only runs **after** the `GenerationRun` fence and the `Book`
mirror check have both held — a stale/superseded caller returns
`'stale_fence'`/`'book_mirror_mismatch'` before the refund lookup ever runs,
so it can never refund. A repeated terminalization attempt for an
already-terminal run likewise never reaches the refund step: its fence
(`status: 'running'` or `'queued'`) no longer matches, so it returns
`'stale_fence'` immediately.

**Eligibility is derived from the matching charge transaction, not from run
status.** The refund step looks up
`CreditTransaction.idempotencyKey = generation:${runId}:charge` inside the
same transaction:

- No matching row → the run predates Phase E2 (or was otherwise never
  charged) → **no refund** — a legacy run can never receive a free credit.
- A matching row exists → the refund's `userId`, `bookId`, and amount
  (`-charge.amount`) are all derived from that row, never hardcoded or
  re-derived from the run/Book — this also makes it structurally impossible
  to refund a charge belonging to a different user/book/run.

If the refund's ledger insert fails for any reason (including its own
idempotency-key collision), the failure propagates out of the transaction
callback and the **entire** terminal transition rolls back — `GenerationRun`
stays non-terminal, `Book` stays untouched, no `AgentLog` rows persist, and
the run remains retryable by a later attempt (BullMQ retry, or the recovery
sweep).

### Transaction composition

`CreditsService`'s balance-UPDATE-plus-ledger-INSERT body was extracted into
a private `mutateCore(tx, input)` that takes a `Prisma.TransactionClient`
rather than opening its own transaction. The public `deduct`/`add` (Phase
E1, unchanged in behavior) wrap it in their own `$transaction`; two new
public methods — `deductInTransaction`/`addInTransaction` — call it directly
against a transaction the caller already holds (`BooksService`'s scheduling
transaction, `GenerationRunCoordinator`'s terminal transition). No nested
`$transaction` calls anywhere, and `CreditsService` remains the only place
that ever writes `User.credits` or inserts a `CreditTransaction` — neither
`BooksService` nor `GenerationRunCoordinator` duplicates any balance/ledger
SQL.

The in-transaction methods require an idempotency key (unlike the standalone
`deduct`/`add`, where it stays optional) and never catch an idempotency-key
conflict the way the standalone path does — a collision there must abort and
roll back the caller's entire transaction, not be silently resolved in
place, since the run/`Book`/outbox writes made earlier in that same
transaction need to unwind too.

### Upgrade compatibility

A `GenerationRun` created before this phase shipped has no
`generation:${runId}:charge` `CreditTransaction` — see "Refund atomicity"
above for how that makes it structurally ineligible for a refund, verified
against a directly-inserted (bypassing `createRunAndSchedule`) run in both
unit and real-Postgres integration coverage.

### Not in scope for Phase E2

Stripe (checkout, webhooks, subscriptions, purchase flow), frontend billing
UI, generation cancellation (added by Phase G1 — see near the end of this
document), partial-completion refund/charge behavior (still unimplemented —
`BookStatus.Partial` remains unreachable), and Redis-backed balance caching
are all still unimplemented — this phase is scoped to wiring the existing
ledger primitive into the generation lifecycle only.

## Phase E3: Stripe Checkout credit purchases and idempotent webhooks

Lets an authenticated user buy more credits via Stripe Checkout — the first
way to acquire credits beyond the schema-default starter balance. Scoped
strictly to one-time purchases: **subscriptions, the Stripe customer portal,
cancellation, promotional codes, and pay-per-book PaymentIntents are all
still unimplemented** (see "Not in scope" below).

### Server-owned package catalog

`apps/api/src/billing/billing-packages.ts` defines the only three purchasable
packages — a client sends a `packageId` and nothing else; it can never
influence which Stripe Price, quantity, currency, or credit amount gets
charged/granted:

| `packageId` | Credits | Price ID env var          |
| ----------- | ------- | ------------------------- |
| `starter`   | 10      | `STRIPE_PRICE_ID_STARTER` |
| `pro`       | 30      | `STRIPE_PRICE_ID_PRO`     |
| `bundle`    | 100     | `STRIPE_PRICE_ID_BUNDLE`  |

`BillingConfigService` resolves a `packageId` against this catalog and the
live env config (`billing-config.service.ts`) — an unknown id, or a known id
whose Price ID env var isn't configured, both resolve to `undefined` and are
rejected the same way (never a partial/guessed price).

### Configuration

`STRIPE_BILLING_ENABLED` (`env.schema.ts`) gates the whole feature — **false
by default**. While false, `POST /api/billing/checkout` fails closed with a
stable `503 { code: 'BILLING_DISABLED' }` and never constructs a Stripe
client or makes a network call (`stripeClientProvider` resolves to `null`).
Flipping it to `true` makes the schema's `superRefine` block **require**
`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, and all three package Price ID
vars — a partially configured enabled deployment fails at **startup** with a
clear, non-secret validation error per missing var, not at first checkout
request. `WEB_APP_URL` (used to build the Checkout success/cancel URLs) is
already unconditionally required/validated by its own schema entry, so it
needs no extra check here. See `.env.example` for operational comments and
test-mode placeholder values.

### Authenticated checkout endpoint

`POST /api/billing/checkout` (`billing.controller.ts`), behind the same
`AuthModeGuard` + `RequireVerifiedEmailGuard` every paid generation endpoint
uses, plus a dedicated Redis-backed per-user rate limit
(`BILLING_CHECKOUT_RATE_LIMIT_WINDOW_MS`/`_MAX_ATTEMPTS`, same
`UserRateLimitGuard` mechanism as `POST /books/:id/generate`). Body is
`{ packageId }` only. `BillingService.createCheckoutSession`:

- Resolves `packageId` through `BillingConfigService` — rejects unknown/
  unavailable ids with `400 { code: 'INVALID_PACKAGE' }`.
- Creates a Stripe Checkout Session with `mode: 'payment'`, exactly one
  server-resolved `{ price: pkg.priceId, quantity: 1 }` line item,
  success/cancel URLs derived from `WEB_APP_URL`, and metadata containing
  only `{ userId, packageId }` — never a Price ID, amount, or currency taken
  from the request.
- **Never grants credits itself** — only returns `{ sessionId, url }`
  (`CheckoutSessionDto`), the minimum the future frontend needs to redirect
  to Stripe's hosted page. The grant happens only once the webhook below
  observes a paid session.
- Any Stripe-side failure (network error, no hosted URL returned) surfaces as
  `502 { code: 'CHECKOUT_UNAVAILABLE' }` — never a raw Stripe error.

**Idempotency-Key header**: an optional `Idempotency-Key` request header lets
a client-retried HTTP request (e.g. a network timeout on the first attempt)
avoid creating a second Stripe Checkout Session for the same intent.
`buildCheckoutIdempotencyKey` (`checkout-idempotency-key.ts`) always prefixes
the value with the authenticated user's id before it's ever used as the
actual Stripe idempotency key — an untrusted raw header value can never
collide across two different users, even if they happen to send the exact
same string. The header is also bounded to a safe charset/length
(`^[A-Za-z0-9_-]{1,200}$`); a missing or unsafe header falls back to a fresh
random suffix (`checkout:${userId}:auto:${uuid}`) — the request still
succeeds, it just isn't deduplicated against a retry that doesn't resend the
same header.

### Public Stripe webhook and raw-body requirement

`POST /api/billing/webhook` (`billing-webhook.controller.ts`) sits outside
every auth guard — Stripe signature verification is its only authentication.
Verifying that signature requires the **exact, unmodified raw request
bytes** Stripe signed, not a re-serialization of the parsed JSON body (which
can silently differ in whitespace/key order). `main.ts` passes `rawBody:
true` to `NestFactory.create`, which makes Nest populate `req.rawBody` (a
`Buffer`) on every request alongside the normal parsed `req.body` — every
other JSON endpoint in the app is unaffected; no `express.json()`/
`express.raw()` wiring had to change.

`BillingService.handleWebhookEvent`:

- Rejects a missing/invalid `Stripe-Signature` header with
  `400 { code: 'INVALID_SIGNATURE' }` — via Stripe's own
  `stripe.webhooks.constructEvent(rawBody, signature, webhookSecret)`, never
  a hand-rolled HMAC check. Never logs the raw payload, the signature, or
  any secret — only stable Stripe event/session ids and outcomes.
- Handles only `checkout.session.completed`. Every other event type Stripe
  might deliver to the same endpoint (Stripe requires selecting event types
  per-endpoint, but the webhook must still tolerate whatever is configured)
  returns normally — a 2xx with no mutation, not an error.

### Payment verification (before granting anything)

A signed `checkout.session.completed` event is **not** by itself permission
to grant credits — `BillingService`'s private `grantCreditsForCheckoutSession`
re-verifies every condition below, in order, before ever calling
`CreditsService.add`. Any failed check is treated as "nothing to grant" and
returns normally (2xx, no mutation); only a genuine Stripe/DB failure while
verifying propagates as a thrown error (see "Retry behavior" below):

1. `session.mode === 'payment'` (never `subscription`/`setup`).
2. `session.payment_status === 'paid'`.
3. `session.metadata.userId` still refers to an existing `User` row.
4. `session.metadata.packageId` maps to the server-owned catalog.
5. The session's **actual Stripe-side line items** — re-fetched via
   `stripe.checkout.sessions.retrieve(sessionId, { expand: ['line_items'] })`,
   never trusted from the webhook payload or its metadata — are exactly one
   item whose `price.id` matches the resolved package's Price ID and whose
   `quantity` is `1`.

### Exactly-once credit grant

Once verified, the grant goes through the same `CreditsService.add` every
other credit mutation in this codebase uses — `BillingService` never writes
`User.credits` or `CreditTransaction` directly:

```ts
creditsService.add({
  userId,
  amount: pkg.credits,
  reason: 'purchase',
  stripePaymentId: session.id,
  idempotencyKey: `stripe:checkout:${session.id}`, // checkoutSessionGrantIdempotencyKey(session.id)
});
```

The idempotency key is derived **only from the Checkout Session id**, never
from the delivered event's own `event.id` — so a redelivery of the same
event, a genuinely concurrent pair of webhook deliveries, and a _different_
Stripe event id that happens to reference the same session (Stripe can emit
more than one event per session in some flows) all converge on the exact
same key and therefore the exact same single `CreditTransaction` row, via
the identical DB-enforced unique-constraint mechanism Phase E1 built (see
above) — not a hand-rolled dedupe table.

### Retry behavior — corrects stale guidance

**On a transient Stripe/DB failure while verifying or granting (a network
error retrieving line items, a dropped DB connection during the ledger
insert), the webhook handler returns a non-2xx response so Stripe retries
the delivery** — it never acknowledges a payment whose grant wasn't durably
committed. This deliberately **contradicts** the "always return 200 to
Stripe even on internal errors" guidance in the older, aspirational
`BACKEND_DESIGN.md` §7.4 and `API_SPEC.md` §20 — those documents predate any
real implementation and describe a design this codebase does not follow.
Only a _business-logic_ "nothing to grant" outcome (unpaid session, unknown
package, mismatched price, etc. — see "Payment verification" above) returns
2xx; a failure that could have left a payment ungranted never does.

### Logging

Only stable, safe identifiers are ever logged: Stripe event id, Checkout
Session id, package id, user id, and outcome (granted / skipped / reason).
Never the raw webhook payload, the `Stripe-Signature` header, any secret, a
customer email, or other payment details.

### Rollout

1. In the Stripe Dashboard (test mode first), create three one-time Prices
   matching the catalog above and copy their Price IDs.
2. Create a webhook endpoint pointed at
   `https://<api-host>/api/billing/webhook`, subscribed at minimum to
   `checkout.session.completed`, and copy its signing secret.
3. Set `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, the three
   `STRIPE_PRICE_ID_*` vars, and a real `WEB_APP_URL` in the deployment's
   environment. Leave `STRIPE_BILLING_ENABLED=false` until all of the above
   are confirmed correct — the app fails to boot if it's set to `true` with
   anything missing.
4. Set `STRIPE_BILLING_ENABLED=true` and redeploy. Verify with a real
   test-mode checkout (`4242 4242 4242 4242`) that the session completes and
   the purchasing user's balance increases by the expected amount.
5. Rollback: set `STRIPE_BILLING_ENABLED=false` again — checkout immediately
   fails closed; no code path is disabled by removing the Stripe env vars
   themselves (the schema simply stops requiring them).

### Not in scope for Phase E3

Subscriptions, the Stripe customer portal, cancellation, promotional codes,
pay-per-book PaymentIntents, and every frontend billing page/redirect flow
remain entirely unimplemented. `Subscription`'s schema table and
`stripeCustomerId`/`stripeSubscriptionId` fields exist but nothing writes to
them yet.

## Phase E4: credits dashboard, checkout redirect, and payment return flow

Exposes safe reads on top of Phase E3's checkout/webhook primitive and builds
the frontend purchase experience. **Still no new way to grant credits** —
this phase adds no mutation endpoint; every credit grant still flows through
the Phase E3 webhook exclusively.

### New authenticated reads

- **`GET /api/billing/packages`** — server-owned catalog for the frontend:
  `{ checkoutEnabled, packages: [{ id, credits }] }`. Never a Price ID, secret,
  or webhook config. `checkoutEnabled` mirrors the same
  `STRIPE_BILLING_ENABLED` + Stripe-client gate `createCheckoutSession` fails
  closed on. While disabled, falls back to the full static catalog (rather
  than the live-config-resolved one, which would filter to nothing) so the UI
  can still list what would be purchasable once billing is enabled — no
  monetary price is ever shown, only the credit quantity ("10 credits").
- **`GET /api/billing/checkout/:sessionId/status`** — authenticated,
  Redis-backed per-user rate limited
  (`BILLING_CHECKOUT_STATUS_RATE_LIMIT_WINDOW_MS`/`_MAX_ATTEMPTS`, a much
  higher budget than the checkout-creation limit since it's a bounded-polling
  local read). Bounds the `:sessionId` path param to a safe,
  Stripe-Checkout-Session-shaped charset (`^cs_[A-Za-z0-9_]{1,255}$`) before
  ever querying, rejecting anything else with
  `400 { code: 'INVALID_CHECKOUT_SESSION_ID' }`. Looks up the exact-once grant
  transaction by the same `checkoutSessionGrantIdempotencyKey(sessionId)` the
  webhook writes, **scoped to the authenticated user in the same query** — a
  session that doesn't exist and a session that belongs to a different user
  both resolve identically to `{ status: 'pending' }`, so this endpoint can
  never be used to probe another user's purchases. **Never makes a Stripe
  network call and never grants credits itself** — it reports durable local
  state only. A found grant returns
  `{ status: 'credited', creditsGranted, balance }` (balance read fresh from
  `CreditsService.getBalance`).

Both DTOs (`CreditPackageCatalogDto`, `CheckoutGrantStatusDto`) live in
`@book/types` alongside the Phase E3 `CheckoutSessionDto`.

### Frontend

- **`apps/web/src/lib/api/billing.ts`** (`billingApi`) and
  **`apps/web/src/lib/api/credits.ts`** (`creditsApi`) — thin `apiFetch`
  wrappers for the reads above plus the existing balance/transactions
  endpoints. `billingApi.createCheckout` takes a caller-supplied
  `Idempotency-Key`; it never generates one itself.
- **`/dashboard/credits`** (`apps/web/src/app/dashboard/credits/page.tsx`) —
  balance, package cards, and cursor-paginated transaction history. A
  `submittingRef` (not React state) guards checkout submission so a
  synchronous double-click can never start two Checkout Sessions even before
  the first render commits the disabled button state. Each distinct purchase
  attempt gets a fresh `crypto.randomUUID()` Idempotency-Key, reused only if
  that same submission needs it again while still in flight. The returned
  Stripe URL is validated (`new URL(url).protocol === 'https:'`) before
  `window.location.assign` — a non-HTTPS or malformed value shows an error and
  never navigates. Transaction rows never render `stripePaymentId`,
  idempotency keys, or any internal id — `CreditTransactionDto` already omits
  them (Phase E1).
- **`/billing/success?session_id=...`** and **`/billing/cancel`**
  (`apps/web/src/app/billing/`) — the exact return URLs Phase E3's
  `BillingService.createCheckoutSession` already emits (`billing.service.ts`,
  unchanged). The success page validates `session_id` client-side against the
  same pattern the API enforces before ever calling
  `billingApi.getCheckoutStatus`; a missing/malformed value shows an error and
  makes no request. Polling is bounded (2s interval, 60s total) and stops on
  unmount, a terminal `credited` result, or timeout — never on a bare 60s
  giving up claiming the payment failed, since the webhook may simply still be
  in flight. A page refresh re-runs the same idempotent read, never a mutation
  — safe to reload any number of times. The cancel page makes no API call at
  all.
- **Dashboard layout** — a small balance indicator and "Buy credits" link in
  the authenticated header. A failed balance fetch degrades to "Credits
  unavailable" text; it never blocks children from rendering. Refetches
  immediately on a `storyme:credits-updated` window event
  (`apps/web/src/lib/credits-events.ts`), which the success page dispatches
  once a session is confirmed `credited` — no need to wait for an unrelated
  re-render to show the new balance.
- **Generation UX** — `apps/web/src/app/dashboard/books/[id]/page.tsx`'s
  `handleGenerate`/`handleRegenerate` (the latter covers both retry and full
  regeneration) detect `ApiError.code === 'INSUFFICIENT_CREDITS'` and show a
  "Buy more credits" link alongside the existing error banner, instead of the
  generic failure message. Every other error keeps its prior generic-message
  behavior unchanged.

### Not in scope for Phase E4

Same exclusions as Phase E3 — subscriptions, the Stripe customer portal,
cancellation, promotional codes, and pay-per-book PaymentIntents remain
entirely unimplemented. This phase adds no custom card form (Stripe Checkout
remains fully hosted) and no way to grant credits outside the Phase E3
webhook.

## Phase G1: cancellation refunds

Wires a third compensating-credit path alongside Phase E2's automatic
failure refund: `POST /api/books/:id/cancel` lets a user voluntarily stop an
in-progress (`queued`/`running`) `GenerationRun` before it finishes. Full
mechanism writeup (the fenced transaction itself, race semantics, outbox/
queue safety): **[apps/api/docs/local-generation-pipeline.md](local-generation-pipeline.md#phase-g1--user-initiated-cancellation)**.
This section covers only the credit-ledger side.

**Eligibility, amount, and idempotency mirror the existing failure-refund
design exactly** — `GenerationRunCoordinator.cancelGeneration` looks up the
original charge by `generationChargeIdempotencyKey(runId)` inside its own
fenced transaction and, only if one exists, refunds via
`CreditsService.addInTransaction` for the charge's exact `amount`/`userId`/
`bookId`, never a hardcoded value:

- **A billed run** — a matching charge exists — is refunded exactly once.
- **A legacy/unbilled run** — no matching charge (predates Phase E2, or was
  otherwise never charged) — is cancelled with `creditsRefunded: 0`, the
  same rule that already protects the failure-refund path from ever
  granting a free credit.
- **Refund eligibility never depends on which pipeline step the run was on**
  when cancelled — this deliberately corrects the aspirational, never-
  implemented `API_SPEC.md` §"POST /v1/books/{bookId}/cancel" guidance
  (refund only before `image_gen`, never during `pdf_render`), which
  predates any real implementation.

**One new `CreditReason`, never reused from the failure path:**
`refund_generation_cancelled` (migration
`20260718000000_phase_g1_generation_cancellation`) — deliberately distinct
from `refund_generation_failure` so a ledger reader (a support dashboard, an
audit export) can always tell a voluntary cancellation refund apart from an
automatic failure refund, even though only one of the two paths can ever
apply to a given run in practice (a run reaches exactly one terminal
status). The refund's own idempotency key,
`generationCancellationRefundIdempotencyKey(runId)`
(`generation:${runId}:cancel_refund`), is likewise distinct from
`generationRefundIdempotencyKey(runId)`'s `generation:${runId}:refund`.

**Race-safe by construction, not by new locking.** Cancellation and
completion both write through the same `GenerationRun`
`status`+`fencingVersion` fence every other terminal transition already
uses — whichever commits first wins, and the loser's own fenced write
matches zero rows before it ever reaches its refund/no-refund decision. Two
concurrent cancellation requests are serialized by Postgres's row lock on
the `GenerationRun` row itself, so exactly one refund is ever inserted, not
two. Proven against real Postgres (not mocks) in
`test/integration/generation-cancellation.integration.spec.ts`.

**Schema**: adds `cancelled` to `GenerationRunStatus`, a nullable
`GenerationRun.cancelledAt` timestamp, and the `refund_generation_cancelled`
`CreditReason` value — no change to `credit_transactions`' shape (reuses the
existing `idempotency_key` column Phase E1 built) and no change to the
`generation_runs_one_active_per_book` partial unique index (`cancelled` was
never in its `WHERE status IN ('queued', 'running')` list, so a cancelled
run is already correctly inactive by that index without any migration).

### Not in scope for Phase G1

No SSE/subscription to observe cancellation happen live, no provider-level
request cancellation (an in-flight OpenAI call already started by
`AgentService` is not aborted — its result simply can never be published once
fenced out), and no partial-completion charge/refund behavior
(`BookStatus.Partial` remains entirely unimplemented).

The web app's "Cancel generation" control (Phase G2 —
`apps/api/docs/local-generation-pipeline.md`, "Phase G2 — frontend
cancellation UX") surfaces this refund outcome directly: "N credit(s)
refunded" when `creditsRefunded > 0`, dispatching the same
`storyme:credits-updated` event `/billing/success` uses so the dashboard
balance refetches, or "No credit charge was found to refund" when it's `0` —
never a guessed or optimistically-adjusted balance.

## Reference: `GENERATION_CREDIT_COST` and key helpers

`apps/api/src/credits/credits.service.ts` exports:

- `GENERATION_CREDIT_COST` (`1`) — the cost of one `GenerationRun`.
- `generationChargeIdempotencyKey(runId)` / `generationRefundIdempotencyKey(runId)`
  / `generationCancellationRefundIdempotencyKey(runId)` — the three
  deterministic key builders described above (charge, automatic failure
  refund, and Phase G1's voluntary cancellation refund, respectively).
- `deductInTransaction(tx, input)` / `addInTransaction(tx, input)` — the
  transaction-composing mutation methods described above.
