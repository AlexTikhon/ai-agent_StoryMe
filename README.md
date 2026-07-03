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

- **No payments/credits enforcement.** `User.credits` and Stripe fields exist
  in the schema but nothing in the API charges credits or calls Stripe.
- **No queue-backed generation.** Generation runs in-process
  (`GenerationTaskRunner`), not on BullMQ/Redis; Redis is provisioned by
  `docker compose` but isn't on the critical path yet. See
  `apps/api/docs/local-generation-pipeline.md`.
- **No cancellation or partial-completion flow.** `BookStatus.Cancelled` and
  `BookStatus.Partial` exist in the schema/types as reserved states for
  future work but no code path currently produces them.
- **Russian/Polish PDF output is not production-ready.** `SupportedLanguage`
  offers `ru` and `pl` in the book-creation form, but the PDF renderer only
  uses PDFKit's built-in fonts (WinAnsi/Latin-1 encoding) — Cyrillic (`ru`)
  renders as blank glyphs entirely, and Polish diacritics (ą ć ę ł ń ó ś ź ż)
  are missing too. Books created in those languages generate successfully
  and the story text is correct, but the exported PDF will have missing
  characters. See `apps/api/docs/pdf-rendering.md#font--unicode-limitation`
  for the fix (embedding licensed Unicode fonts) — deliberately not done in
  this pass; no font was added without an explicit licensing decision.

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

- Wire credit deduction and Stripe billing.
- Move generation onto the BullMQ/Redis queue instead of in-process execution.
- Decide whether `BookStatus.Partial`/`Cancelled` become reachable (partial
  generation recovery, user-initiated cancellation) or should be dropped.
- `prisma:seed` was removed as a package script (previously pointed at a
  nonexistent `apps/api/prisma/seed.ts`, and the seed data ROADMAP.md
  originally described assumed password-based login, which doesn't match the
  current dev-auth model). Local demo data is created through the app itself
  — see [docs/local-demo.md](docs/local-demo.md). Revisit if fixture data
  becomes useful once real auth lands.
