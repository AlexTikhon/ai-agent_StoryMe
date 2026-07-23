# StoryMe: Current Product

This is the source of truth for what the repository implements now. The root PRD, API
specification, architecture, design, UX, and roadmap files preserve historical intent and future
design; they are not implementation contracts.

## Supported flow

Users can register with email/password, verify email, log in, restore a session through a rotating
HttpOnly refresh cookie, and reset a password. They can create and edit an owned book draft with
title, child name/age, language (`en`, `ru`, `pl`), theme, page count, optional lesson, and an
optional reference photo. Starting generation atomically creates a run/outbox event and charges a
credit. A separate BullMQ worker generates the story, images, layout, and PDF. The detail screen
polls status and supports cancellation, retry from a failed run's immutable snapshot,
regeneration from current input, diagnostics, and authenticated PDF download. Users can view
their credit ledger and, when explicitly enabled, buy one-time packages through Stripe Checkout.

JWT mode is the default. A local-only `dev` auth mode exists and must not be exposed publicly.

## API routes

All routes have the `/api` prefix.

| Method           | Route                                 | Behavior                                 |
| ---------------- | ------------------------------------- | ---------------------------------------- |
| GET              | `/health`                             | PostgreSQL and Redis health              |
| POST             | `/auth/register`                      | Create account and refresh cookie        |
| POST             | `/auth/login`                         | Authenticate and set refresh cookie      |
| POST             | `/auth/refresh`                       | Rotate refresh token                     |
| POST             | `/auth/logout`                        | Revoke token and clear cookie            |
| GET              | `/auth/me`                            | Current authenticated user               |
| POST             | `/auth/verify-email`                  | Consume verification token               |
| POST             | `/auth/resend-verification`           | Request verification message             |
| POST             | `/auth/request-password-reset`        | Request reset without enumeration        |
| POST             | `/auth/reset-password`                | Consume reset token                      |
| GET/POST         | `/books`                              | List owned books / create draft          |
| GET/PATCH/DELETE | `/books/:id`                          | Read, edit, or soft-delete an owned book |
| POST             | `/books/:id/child-photo`              | Validate, re-encode, and store photo     |
| POST             | `/books/:id/generate`                 | Schedule initial generation              |
| POST             | `/books/:id/retry-generation`         | Resume failed snapshot                   |
| POST             | `/books/:id/regenerate`               | Generate from current input              |
| POST             | `/books/:id/cancel`                   | Fence/cancel active run and refund once  |
| GET              | `/books/:id/generation-diagnostics`   | Owned run/artifact diagnostics           |
| GET              | `/books/:id/pdf/preview`              | Ownership-checked PDF bytes              |
| GET              | `/credits/balance`                    | Canonical owned balance                  |
| GET              | `/credits/transactions`               | Cursor-paginated owned ledger            |
| GET              | `/billing/packages`                   | Server package catalog                   |
| POST             | `/billing/checkout`                   | Hosted one-time Checkout session         |
| GET              | `/billing/checkout/:sessionId/status` | Durable grant state                      |
| POST             | `/billing/webhook`                    | Stripe-signature-authenticated webhook   |

The webhook is intentionally public; health is public. Other feature routes use authentication,
and ownership comes from the authenticated user rather than client-supplied user IDs.

## Frontend routes

`/`, `/register`, `/login`, `/verify-email`, `/forgot-password`, `/reset-password`, `/dashboard`,
`/dashboard/books/new`, `/dashboard/books/[id]`, `/dashboard/credits`, `/billing/success`, and
`/billing/cancel`.

There is no in-browser page reader. The book detail screen shows internal image asset keys rather
than rendered generated illustrations.

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
page plan, story text, illustration plan and preview, image generation/reuse, deterministic
layout, and PDF publication. The current orchestrator primarily persists `Book` as `created`,
then `layout`, then `complete` or `failed`; cancellation writes `cancelled`. Finer enum values are
largely diagnostic/historical and are not each persisted as progress states. `partial` is
unreachable.

`GenerationRun` (`queued`, `running`, then `completed`, `failed`, or `cancelled`) is the durable
execution source of truth. Every write verifies `(runId, fencingVersion)`. Reuse requires matching
input identity and valid claim-scoped bytes. Success atomically advances the published pointer;
a later failed/cancelled regeneration preserves the previous publication.

## Implemented and unimplemented

Implemented: JWT auth/recovery, ownership enforcement, safe child-photo processing, draft CRUD
and soft-delete, durable queued generation, fencing/heartbeat/recovery, cancellation,
retry/resume, idempotent charges/refunds, one-time credit purchases, provider limits, local/S3/R2
artifacts, authenticated PDF access, and extensive unit/integration tests.

Not implemented: OAuth flow, subscriptions/customer portal, public sharing, child-profile
management, reader and image thumbnails/previews, single-page editing/regeneration, bounded LLM
repair, hard-delete/data-erasure workflow, Playwright E2E, and production/admin gating for
diagnostics.

Known limitations: `AgentService` and the worker-execution/cancellation portion of `BooksService`
remain oversized; admission and transactional scheduling now live in `BookGenerationService`;
`GenerationJob` is still written and recovered as a best-effort legacy mirror, although product
diagnostics now read authoritative `GenerationRun`; Book soft-delete does not erase artifacts;
local storage cannot serve separately deployed API/worker processes; console email does not
deliver production mail.

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

The production web build requires a valid `NEXT_PUBLIC_API_URL` ending in `/api`.
