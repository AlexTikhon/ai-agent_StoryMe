# StoryMe

A personalized children's-storybook generator: fill in a child's name, age,
and a theme, and the pipeline produces a short illustrated story and a
downloadable PDF.

This is a pnpm/Turborepo monorepo:

- `apps/api` (`@book/api`) — NestJS API, Prisma/Postgres
- `apps/web` (`@book/web`) — Next.js frontend
- `packages/types` (`@book/types`) — types shared between API and web

## Quick start

See **[docs/local-demo.md](docs/local-demo.md)** for the full local setup and
demo walkthrough (install → Docker infra → migrate → run API/web → create and
generate a book → download the PDF).

## What the MVP does

- Create a book from a short form (child's name/age, theme, language,
  page count, optional educational message/dedication).
- Generate the story (character, story plan, page plan, draft text,
  illustration plan, images) through a polling status pipeline
  (`created` → … → `complete`), visible live on the book detail page.
- Render and preview/download the finished book as a PDF.
- Retry generation after a failure.

## Authentication

Real email/password auth (JWT access token + rotating `HttpOnly` refresh
cookie) is implemented end-to-end — backend (`docs/auth-architecture.md`)
and frontend (login/register pages, `AuthProvider`, protected `/dashboard`
routes). Controlled by `AUTH_MODE` (API) / `NEXT_PUBLIC_AUTH_MODE` (web),
both `dev | jwt`, defaulting to `jwt`. `dev` mode is kept as a documented
local-only fallback: every request carries a hardcoded `x-user-email`
header (`DevAuthGuard`) instead of a bearer token, no login screen, no
credential check. See `apps/api/src/auth/dev-auth.guard.ts` and
`apps/api/src/auth/auth-mode.guard.ts`. **The two `AUTH_MODE` values must
match between API and web** or every request 401s.

## What it does not do yet

- **Generation credit enforcement is implemented:** every
  `POST /books/:id/generate`, `retry-generation`, or `regenerate` call
  charges 1 credit the moment the run is durably scheduled (not when
  generation completes), returns the stable `402 { code:
  'INSUFFICIENT_CREDITS' }` if the balance is too low, and a run that later
  fails is automatically refunded exactly once — see
  [apps/api/docs/credits.md](apps/api/docs/credits.md), "Phase E2".
- **One-time credit purchasing via Stripe Checkout is implemented**
  (`POST /api/billing/checkout` + the `POST /api/billing/webhook` credit
  grant) — see [apps/api/docs/credits.md](apps/api/docs/credits.md),
  "Phase E3". Disabled by default (`STRIPE_BILLING_ENABLED=false`) until a
  deployment supplies real Stripe configuration. **Subscriptions, the Stripe
  customer portal, cancellation, promotional codes, pay-per-book
  PaymentIntents, and every frontend billing page remain unimplemented** —
  the schema-default starter balance (`User.credits` defaults to `3`) and a
  one-time Checkout purchase are currently the only two ways an account gets
  credits.
- ~~No queue-backed generation.~~ Generation now runs on a durable
  BullMQ/Redis-backed queue (`GenerationQueueService`/`GenerationQueueProcessor`),
  not in-process — Redis is on the critical path for scheduling generation.
  See "Durable generation queue (Phase 3K)" in
  `apps/api/docs/local-generation-pipeline.md`.
- **No cancellation or partial-completion flow.** `BookStatus.Cancelled` and
  `BookStatus.Partial` exist in the schema/types as reserved states for
  future work but no code path currently produces them.
- ~~Russian/Polish PDF output is not production-ready.~~ The PDF renderer
  now embeds Noto Sans (OFL-licensed, Latin/Cyrillic/Greek coverage), so
  `ru` and `pl` books render correctly. See "Font / Unicode support" in
  `apps/api/docs/pdf-rendering.md`.

## Mock vs. real (OpenAI) generation

Story and image generation each have a provider switch, both defaulting to a
deterministic **mock** provider (no network calls, safe for tests/CI):

- `STORY_GENERATION_PROVIDER` — `mock` (default) | `openai`
- `IMAGE_GENERATION_PROVIDER_TOKEN` — `mock` (default) | `openai`

Setting either to `openai` requires `OPENAI_API_KEY` and calls the real
OpenAI API (real image generation costs money per call — see the
`REAL_GENERATION_MAX_PAGES` guardrail in `.env.example`). Full details in
`apps/api/docs/local-generation-pipeline.md`.

## PDF storage

`PDF_STORAGE_DRIVER` selects the backing store for generated PDFs:

- `local` (default) — written to `apps/api/tmp/`, no external service needed.
- `s3` / `r2` — requires the `PDF_STORAGE_*` credentials in `.env.example`
  and is only exercised by the manual `smoke:pdf-storage` script, never by
  the normal test suite. See `apps/api/docs/pdf-storage-smoke-test.md`.

The PDF preview endpoint is always `GET /api/books/:id/pdf/preview`, regardless
of driver.

## Image asset storage

`IMAGE_STORAGE_DRIVER` selects the backing store for generated cover/page
images, independently of `PDF_STORAGE_DRIVER`:

- `local` (default) — written to `apps/api/tmp/`, no external service needed.
- `s3` / `r2` — reuses the **same** `PDF_STORAGE_*` credentials as PDF storage
  above (bucket, region, endpoint, access key, secret); images are stored
  under an `images/` prefix in that same bucket, so no separate credentials
  are needed. Not exercised by the normal test suite (mocked there, same as
  PDF storage).

## Environment

Copy `.env.example` to `apps/api/.env` and adjust as needed — see
[docs/local-demo.md](docs/local-demo.md#3-configure-environment) for the
minimal setup. The web app needs no `.env` for local use; set
`NEXT_PUBLIC_API_URL` in `apps/web/.env.local` only if the API runs elsewhere.

`pnpm --filter @book/web dev` needs none of this — it falls back to
`http://localhost:4000/api`. `pnpm --filter @book/web build` always runs in
production mode, though, and this app refuses to fall back to localhost
there (`apps/web/src/lib/api/config.ts`) — a `check-build-env.js` prebuild
step fails fast with one clear message if `NEXT_PUBLIC_API_URL` is unset,
rather than letting `next build` error once per static page. To build
locally: `NEXT_PUBLIC_API_URL="http://localhost:4000/api" pnpm --filter
@book/web build`. Vercel/Railway/CI must set it as a real build-time env var
(see [docs/private-demo-deploy.md §10](docs/private-demo-deploy.md#10-vercel--railway-concrete-deployment-configuration)).

## Deployment readiness

See **[docs/deployment-readiness.md](docs/deployment-readiness.md)** for a
deployment-blockers audit, storage/auth limitation notes, and a recommended
architecture — this has not been deployed anywhere yet.

For an actual step-by-step deploy procedure (provider choices, exact env
vars, migration/release order, smoke test), see
**[docs/private-demo-deploy.md](docs/private-demo-deploy.md)** — scoped to a
**private/internal demo only**, since `DevAuthGuard` is not safe to expose
publicly.

## Known post-MVP TODOs

- ~~Build Stripe billing (checkout, webhooks, purchasing more credits) on top
  of the Phase E1/E2 credit accounting foundation~~ **One-time purchases
  done (Phase E3)** — see [apps/api/docs/credits.md](apps/api/docs/credits.md),
  "Phase E3". Subscriptions, the Stripe customer portal, cancellation,
  promotional codes, and a frontend billing page are still missing.
- Decide whether `BookStatus.Partial`/`Cancelled` become reachable (partial
  generation recovery, user-initiated cancellation) or should be dropped.
- `prisma:seed` was removed as a package script (previously pointed at a
  nonexistent `apps/api/prisma/seed.ts`, and the seed data ROADMAP.md
  originally described assumed password-based login, which doesn't match the
  current dev-auth model). Local demo data is created through the app itself
  — see [docs/local-demo.md](docs/local-demo.md). Revisit if fixture data
  becomes useful once real auth lands.
