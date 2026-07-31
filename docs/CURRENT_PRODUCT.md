# StoryMe: Current Product

This is the source of truth for what the repository implements now. The root PRD, API
specification, architecture, design, UX, and roadmap files preserve historical intent and future
design; they are not implementation contracts.

## Supported flow

Users can register with email/password, verify email, log in, restore a session through a rotating
HttpOnly refresh cookie, and reset a password. They can create and edit an owned book draft with
title, child name/age, language (`en`, `ru`, `pl`), theme, page count, optional lesson, and an
optional reference photo. `PRODUCT_MODE=home` is the default private-family mode: generation keeps
all provider and capacity guardrails but does not debit credits or expose purchasing. The opt-in
`demo` mode retains credit debits and Stripe purchase UI. Starting generation atomically creates a
run/outbox event and, in demo mode only, charges a credit. A separate BullMQ worker generates the
story, images, layout, and PDF. Before generation, the API can return a server-owned provider-call,
cost, and duration estimate and enforces configured hard limits before charging or scheduling. The detail screen
polls status and supports cancellation, retry from a failed run's immutable snapshot,
regeneration from current input, authenticated PDF download, version-checked text correction, and
explicitly confirmed image regeneration for one page of a completed book. A page text correction
reuses every published image, invokes no AI provider, charges no credit, and atomically republishes
the dependent layout/PDF. A page image regeneration first displays a server-owned one-credit
quote; only confirmation schedules the paid call, and failure preserves the book and refunds that
credit. Developer diagnostics and
intermediate technical details are opt-in through
`NEXT_PUBLIC_ENABLE_DEVELOPER_DIAGNOSTICS=true`; when disabled, the browser does not request
diagnostics. The ordinary progress banner reads a minimal owned `GenerationRun` projection and
shows only fenced stages the worker has durably entered, without internal logs or invented
percentages. Users can view their credit ledger and, when explicitly enabled, buy one-time
packages through Stripe Checkout.

JWT mode is the default. A local-only `dev` auth mode exists and must not be exposed publicly.

## API routes

All routes have the `/api` prefix.

| Method           | Route                                                              | Behavior                                 |
| ---------------- | ------------------------------------------------------------------ | ---------------------------------------- |
| GET              | `/health`                                                          | PostgreSQL and Redis health              |
| POST             | `/auth/register`                                                   | Create account and refresh cookie        |
| POST             | `/auth/login`                                                      | Authenticate and set refresh cookie      |
| POST             | `/auth/refresh`                                                    | Rotate refresh token                     |
| POST             | `/auth/logout`                                                     | Revoke token and clear cookie            |
| GET              | `/auth/me`                                                         | Current authenticated user               |
| POST             | `/auth/verify-email`                                               | Consume verification token               |
| POST             | `/auth/resend-verification`                                        | Request verification message             |
| POST             | `/auth/request-password-reset`                                     | Request reset without enumeration        |
| POST             | `/auth/reset-password`                                             | Consume reset token                      |
| GET/POST         | `/books`                                                           | List owned books / create draft          |
| GET/PATCH/DELETE | `/books/:id`                                                       | Read, edit, or soft-delete an owned book |
| POST             | `/books/:id/child-photo`                                           | Validate, re-encode, and store photo     |
| POST             | `/books/:id/generate`                                              | Schedule initial generation              |
| POST             | `/books/:id/retry-generation`                                      | Resume failed snapshot                   |
| POST             | `/books/:id/regenerate`                                            | Generate from current input              |
| POST             | `/books/:id/cancel`                                                | Fence/cancel active run and refund once  |
| GET              | `/books/:id/generation-estimate`                                   | Server-owned provider-work estimate      |
| GET              | `/books/:id/generation-progress`                                   | Minimal owned durable progress           |
| GET              | `/books/:id/generation-diagnostics`                                | Owned run/artifact diagnostics           |
| GET              | `/books/:id/pdf/preview`                                           | Ownership-checked PDF bytes              |
| GET              | `/books/:id/images/:imageId`                                       | Ownership-checked published image bytes  |
| PATCH            | `/books/:id/pages/:pageNumber/text`                                | Versioned page text edit and PDF rebuild |
| POST             | `/books/:id/pages/:pageNumber/image-regeneration-quote`            | Quote one page image without charging    |
| POST             | `/books/:id/pages/:pageNumber/image-revisions/:revisionId/confirm` | Confirm charge and queue revision        |
| GET              | `/books/:id/page-image-revisions/:revisionId`                      | Read owned durable revision status       |
| GET              | `/credits/balance`                                                 | Canonical owned balance                  |
| GET              | `/credits/transactions`                                            | Cursor-paginated owned ledger            |
| GET              | `/billing/packages`                                                | Server package catalog                   |
| POST             | `/billing/checkout`                                                | Hosted one-time Checkout session         |
| GET              | `/billing/checkout/:sessionId/status`                              | Durable grant state                      |
| POST             | `/billing/webhook`                                                 | Stripe-signature-authenticated webhook   |

The webhook is intentionally public; health is public. Other feature routes use authentication,
and ownership comes from the authenticated user rather than client-supplied user IDs.

## Frontend routes

`/`, `/register`, `/login`, `/verify-email`, `/forgot-password`, `/reset-password`, `/dashboard`,
`/dashboard/books/new`, `/dashboard/books/[id]`, `/dashboard/credits`, `/billing/success`, and
`/billing/cancel`.

The completed-book detail screen has an authenticated in-browser reader for the published cover,
every generated story page, and the back cover. It lazily fetches one owned published image at a
time without exposing storage keys. Library cards show the ownership-checked published cover when
one exists and a neutral placeholder otherwise. A story page can be edited in place; the UI sends
its expected version, explains that illustrations are unchanged and no credit is charged, and
refreshes the reader from the atomically republished book. It can also request a one-page image
quote, show the exact credit charge before confirmation, poll the durable revision, and refresh
only after atomic publication. With developer diagnostics explicitly enabled,
the book detail screen shows internal image asset keys and intermediate pipeline details.

## Providers and storage

- Story, character-profile, and image providers each support deterministic mock or OpenAI.
- Email supports console or Resend. Stripe one-time billing is disabled by default.
- PDF and image storage support local, S3, or R2. Images have a separate driver selector but reuse
  `PDF_STORAGE_*` bucket credentials.
- Automated tests use mock/fake providers and make no real OpenAI, Stripe, Resend, S3, or R2 call.

Local processed photos and generated images live under `apps/api/tmp/images/`; local PDFs live
under `apps/api/tmp/books/`. Claim-scoped keys carry book, run, and fencing identity. Cloud
drivers use equivalent bucket keys. PDFs are not exposed through a public static directory.

## Actual generation workflow

`HTTP schedule -> PostgreSQL transaction (Book + GenerationRun + credit + outbox) -> outbox
dispatcher -> BullMQ/Redis -> worker claim/heartbeat/fencing -> deterministic pipeline ->
transactional terminal publication`.

The content stages are character profile/sheet, one story-provider result containing story plan,
page plan, story text, illustration plan and preview, deterministic quality review, an optional
single bounded repair attempt for repairable findings, image generation/reuse, deterministic
layout, and PDF publication. The current orchestrator primarily
persists `Book` as `created`,
then the scheduled `char_build` marker, `layout`, and finally `complete` or `failed`;
cancellation writes `cancelled`. The authoritative `GenerationRun.currentStep` separately records
the major stages the worker actually enters: `char_build`, `story_plan`, `qa_review`, `image_gen`,
`layout`, and `pdf_render`. Finer Book/step enum values remain diagnostic or historical and are
not fabricated as progress. `partial` is unreachable. Deterministic quality errors stop the run
before page-image generation and persist only typed, privacy-safe findings.

`GenerationRun` (`queued`, `running`, then `completed`, `failed`, or `cancelled`) is the durable
execution source of truth. Every write verifies `(runId, fencingVersion)`. Reuse requires matching
input identity and valid claim-scoped bytes. Success atomically advances the published pointer;
a later failed/cancelled regeneration preserves the previous publication.

## Implemented and unimplemented

Implemented: JWT auth/recovery, ownership enforcement, safe child-photo processing, draft CRUD
and soft-delete, durable queued generation, fencing/heartbeat/recovery, cancellation,
retry/resume, idempotent charges/refunds, one-time credit purchases, provider limits, local/S3/R2
artifacts, authenticated PDF and published-image access, an authenticated completed-book reader,
published cover thumbnails in the library, durable user-facing generation progress, and
versioned one-page text correction and explicitly confirmed one-page image regeneration with
failure-safe PDF republication, a deterministic pre-image quality gate, privacy-safe request/run
correlation, Playwright coverage of the real local API/worker boundary, and explicit owned,
fenced, retriable hard deletion across PostgreSQL and configured artifact storage.

Not implemented: OAuth flow, subscriptions/customer portal, public sharing, child-profile
management, automatic retention scheduling, and role-based admin authorization for diagnostics.
The reader follows published artifact availability rather than current run status, so a previous
complete publication remains readable while regeneration is running, failed, or cancelled. The web
diagnostics UI is environment-gated and defaults off; the owned diagnostics API contract remains
available.

Known limitations: `AgentService` remains larger than the individual stages it orchestrates;
`BooksService` is now a compatibility facade over CRUD, asset, diagnostics, generation scheduling,
and generation execution services; the legacy `GenerationJob` runtime and Prisma model have been
removed in favor of authoritative `GenerationRun`; Book soft-delete does not erase artifacts and
must not be confused with the separate irreversible hard-delete workflow; local storage cannot
serve separately deployed API/worker processes; console email does not deliver production mail.
English, Russian, and Polish mock stories are deterministic and localized. Character profiles now
carry a canonical versioned appearance fingerprint and one locked illustration fragment. Bounded story repair exists but is
disabled by default and requires an explicitly configured repair-capable story provider and
paid-call budget.

The code-derived model/enum retention decisions are documented in
[PHASE_7_SCHEMA_AUDIT.md](PHASE_7_SCHEMA_AUDIT.md); Phase 7 intentionally includes no destructive
schema migration.

## Local run and validation

Prerequisites: Node 20+, pnpm 9+, Docker, and Docker Compose.

```text
pnpm install
docker compose up -d postgres redis
```

Create untracked `apps/api/.env` from the root `.env.example`, keep generation providers in mock
mode, then run:

```text
pnpm --filter @book/api prisma:generate
pnpm --filter @book/api prisma:migrate:deploy
pnpm --filter @book/api dev
pnpm --filter @book/api dev:worker
pnpm --filter @book/web dev
```

See [local-demo.md](local-demo.md) for the walkthrough. Validation commands are:

```text
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm --filter @book/api test:integration
```

The production web build requires a valid `NEXT_PUBLIC_API_URL` ending in `/api`. Leave
`NEXT_PUBLIC_ENABLE_DEVELOPER_DIAGNOSTICS` unset/false for the ordinary product UI; enable it only
for trusted developer builds.
