# Credits

Covers the internal credit-accounting system: the ledger primitive built in
Phase E1, and Phase E2's wiring of that primitive into the generation
lifecycle (scheduling-time charge, failure-time refund). Stripe itself
(checkout, webhooks, subscriptions, purchase) remains entirely unimplemented
— see "Not in scope" at the end of each phase's section below.

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
UI, cancellation, partial-completion refund/charge behavior, and Redis-backed
balance caching are all still unimplemented — this phase is scoped to
wiring the existing ledger primitive into the generation lifecycle only.

## Reference: `GENERATION_CREDIT_COST` and key helpers

`apps/api/src/credits/credits.service.ts` exports:

- `GENERATION_CREDIT_COST` (`1`) — the cost of one `GenerationRun`.
- `generationChargeIdempotencyKey(runId)` / `generationRefundIdempotencyKey(runId)`
  — the two deterministic key builders described above.
- `deductInTransaction(tx, input)` / `addInTransaction(tx, input)` — the
  transaction-composing mutation methods described above.
