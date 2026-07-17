# Private Demo Deployment Runbook

A concrete, step-by-step guide to deploying the current MVP to a **private,
internal** environment — not a general-purpose production deployment guide.
For the underlying audit this runbook is based on (what's already
deploy-ready vs. what's a known gap), see
[docs/deployment-readiness.md](deployment-readiness.md). For local dev setup,
see [docs/local-demo.md](local-demo.md).

## ⚠️ Private/internal only — read this first

- **As of Phase 6C, both API and web have real auth wired end-to-end**
  (register/login/JWT access tokens/rotating refresh cookies — see
  [docs/auth-architecture.md](auth-architecture.md)), gated by
  `AUTH_MODE` (API) and `NEXT_PUBLIC_AUTH_MODE` (web), both `dev | jwt`.
  **This runbook now deploys with `AUTH_MODE=jwt` /
  `NEXT_PUBLIC_AUTH_MODE=jwt`** — real login/register, no shared identity.
  The two values must match between API and web deployments or every
  request 401s.
- **`AUTH_MODE=dev` remains available as a documented local-only fallback**,
  not for any deployment reachable by anyone other than the operator. In
  that mode every request is scoped to a user by a plain `x-user-email`
  header — the API creates/looks up a matching `User` row on the fly with
  **no password, session, or token check** (see
  `apps/api/src/auth/dev-auth.guard.ts`). If a deployment is ever
  misconfigured with `AUTH_MODE=dev`, anyone who can reach the API and set
  `x-user-email` can impersonate any user — restrict access at the platform
  level (password-protect the Vercel deployment or restrict to a
  team/allowlist, and consider an IP allowlist or basic auth in front of the
  API host) if that ever happens.
- **Even with real auth, this is still scoped as a private/internal demo**
  — auth rate limiting (Phase 6E), email verification (Phase 6F), password
  reset (Phase 6G), and a real transactional email provider (Phase 6H) are
  all done. Email still defaults to `ConsoleEmailService` (logs the link
  instead of sending it) unless you explicitly set `EMAIL_PROVIDER=resend`
  plus `RESEND_API_KEY`/`EMAIL_FROM` for this deployment — see
  [§3 Environment variable matrix](#3-environment-variable-matrix) below and
  [docs/auth-architecture.md §16](auth-architecture.md#16-phase-6h--real-transactional-email-provider).
  Do not treat this runbook as a public-launch checklist; see
  [deployment-readiness.md](deployment-readiness.md) for what's still
  outstanding beyond auth.

**Deploying specifically to Vercel + Railway?** Skip straight to
[§10 Vercel + Railway: concrete deployment configuration](#10-vercel--railway-concrete-deployment-configuration)
for exact build/start/migrate commands, config files, and an env var list
scoped to that pair of platforms. §§1–9 below remain the general-purpose
version of this runbook (any Docker host for the API, any Node host for the
web app).

## 1. Target architecture

```
Browser
  │
  ▼
apps/web (Next.js, Vercel)  ──HTTPS, CORS──▶  apps/api (NestJS, Docker on Render/Fly/Railway)
                                                    │           │
                                                    ▼           ▼
                                            managed Postgres  managed Redis
                                                    │
                                                    ▼
                                          S3/R2 bucket (PDFs + images)
```

- **Web**: `apps/web` — Next.js 14 App Router, dynamic SSR (the
  `/dashboard/books/[id]` route rules out static export). Deployed to Vercel.
- **API**: `apps/api` — NestJS, Dockerized (`apps/api/Dockerfile`, verified
  building and booting end-to-end — see
  [Phase 5C](deployment-readiness.md#phase-5c-docker)).
- **Database**: managed Postgres. Migrations are Postgres-specific and run
  as a separate release step, never inside the container.
- **Storage**: S3-compatible bucket (Cloudflare R2 or AWS S3) for generated
  PDFs and images — both storage drivers are fully implemented
  (`CloudPdfStorage`, `CloudImageAssetStorage`).
- **Generation**: durable BullMQ/Redis-backed queue (Phase 3K,
  `GenerationQueueService`/`GenerationQueueProcessor`) — the worker runs as
  its own entrypoint (`apps/api/src/worker.ts`, `ENABLE_GENERATION_WORKER=true`),
  a separate deploy from the API process, and Redis is a hard runtime
  dependency for both (see [Is Redis required?](#is-redis-required) below).
- **Auth**: `JwtAuthGuard` (email/password + JWT + rotating refresh cookie),
  `AUTH_MODE=jwt` by default — see the warning above.
- **Redis**: see [Is Redis required?](#is-redis-required) below — short
  answer: **yes, to boot and to generate books** (Phase 3K).

## 2. Recommended provider path

| Piece             | Recommendation                                                                                                 | Why                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ----------------- | -------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Web               | **Vercel**                                                                                                     | Zero-config Next.js hosting, matches Phase 5D's audited path exactly (no Dockerfile needed).                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| API               | **Render, Fly.io, or Railway** (Docker service)                                                                | All three run an arbitrary Dockerfile as an always-on instance. Since Phase 3K, generation is a durable BullMQ/Redis queue rather than an in-process runner, so this pick is no longer forced by generation architecture — see [Known limitations](#known-limitations) for what still favors care before autoscaling (default `local` storage drivers, redundant recovery sweeps). Pick whichever the team already has an account on; nothing below is provider-specific beyond "runs a Docker image and lets you set env vars." |
| Generation worker | **Same host as the API** (second Docker service, same image, `node dist/worker` start command)                 | Deployed separately from the API — see [§4a Deploy the generation worker](#4a-deploy-the-generation-worker). Must run as its own process/container in every deployed environment; `ENABLE_GENERATION_WORKER=true` is a local single-process dev convenience only, never set on either deployed service.                                                                                                                                                                                                                          |
| Database          | **Neon or Supabase** (managed Postgres), or the API host's own managed Postgres add-on if using Render/Railway | Either works; schema/migrations are plain Postgres, no provider-specific features used.                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Storage           | **Cloudflare R2**                                                                                              | Already the primary implementation target (`PDF_STORAGE_DRIVER=r2` / `IMAGE_STORAGE_DRIVER=r2`), S3-compatible, no egress fees. AWS S3 works identically via `PDF_STORAGE_DRIVER=s3`.                                                                                                                                                                                                                                                                                                                                            |
| Redis             | **A small managed Redis** (Upstash, Redis Cloud, or the API host's own Redis add-on)                           | Required for the app to boot, pass `/api/health`, and schedule/run every generation job (BullMQ, Phase 3K) — see below. A free/smallest tier is enough; nothing performance-sensitive runs through it today.                                                                                                                                                                                                                                                                                                                     |

This is the same architecture already recommended in
[deployment-readiness.md's Recommended deployment architecture](deployment-readiness.md#recommended-deployment-architecture);
this runbook just turns it into an ordered list of commands.

### Is Redis required? {#is-redis-required}

**Yes — both to satisfy the app's boot-time checks and for its intended
purpose (queue-backed generation, Phase 3K, and Redis-backed rate limiting).**

- `REDIS_URL` is a **required**, non-optional env var
  (`apps/api/src/config/env.schema.ts`) — the app refuses to start without a
  valid `redis://` URL.
- `RedisService` (`apps/api/src/cache/redis.service.ts`) opens a real,
  eager connection to it at `onModuleInit` (not lazy) — a container that
  can't reach Redis will log connection errors continuously.
- `GET /api/health` actively pings Redis and reports `redis: down` (and a
  non-200 status) if it's unreachable — so a health-check-gated deploy
  (Docker `HEALTHCHECK`, a platform's readiness probe) will never go healthy
  without it.
- **BullMQ is on the critical path for generation (Phase 3K).** Every
  `POST /:id/generate`/`retry-generation` call enqueues onto
  `QUEUES.BOOK_GENERATION` (`apps/api/src/agent/generation-queue.service.ts`),
  and `GenerationQueueProcessor` (a `@Processor` in the same process) is what
  actually runs the pipeline. Redis being unreachable now means new
  generations can't even be scheduled (the request fails with a 500, and the
  book/job are marked failed — see
  `apps/api/docs/local-generation-pipeline.md`'s "Durable generation queue
  (Phase 3K)" section), not just a health-check symptom.

Practically: provision the smallest/free tier of a managed Redis add-on and
set `REDIS_URL` — this is a hard runtime dependency, not optional
infrastructure.

## 3. Environment variable matrix

"Required for private demo?" assumes mock generation (no OpenAI spend) and
cloud storage (not local filesystem, since most container hosts have an
ephemeral filesystem — see
[Known blockers #1](deployment-readiness.md#known-blockers)).

| Variable                                                                                                                     | App          | Required for private demo?                           | Example value shape                             | Notes                                                                                                                                                                                                                                                                                                                                                                      |
| ---------------------------------------------------------------------------------------------------------------------------- | ------------ | ---------------------------------------------------- | ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                                                                                                               | API          | **Yes**                                              | `postgresql://user:pass@host:5432/db`           | Managed Postgres connection string.                                                                                                                                                                                                                                                                                                                                        |
| `REDIS_URL`                                                                                                                  | API          | **Yes**                                              | `redis://:password@host:6379`                   | See [Is Redis required?](#is-redis-required) — needed to boot and pass health checks, not for queue processing yet.                                                                                                                                                                                                                                                        |
| `JWT_SECRET`                                                                                                                 | API          | **Yes**                                              | 32+ char random hex, `openssl rand -hex 32`     | Signs/verifies access tokens (`JwtAuthGuard`, `TokenService`).                                                                                                                                                                                                                                                                                                             |
| `JWT_REFRESH_SECRET`                                                                                                         | API          | **Yes**                                              | 32+ char random hex, `openssl rand -hex 32`     | HMAC key used to hash refresh tokens before they're stored in `RefreshToken.tokenHash`.                                                                                                                                                                                                                                                                                    |
| `AUTH_MODE`                                                                                                                  | API          | No (defaults to `jwt`, recommended for this runbook) | `dev` \| `jwt`                                  | Must match the web app's `NEXT_PUBLIC_AUTH_MODE` exactly — a mismatch 401s every request. Only set to `dev` for a trusted-operator-only deployment (see the warning above).                                                                                                                                                                                                |
| `PORT`                                                                                                                       | API          | No (has default `4000`)                              | `4000`                                          | Most hosts (Render/Fly/Railway) set this automatically; the API already reads and binds it on `0.0.0.0`.                                                                                                                                                                                                                                                                   |
| `ALLOWED_ORIGINS`                                                                                                            | API          | **Yes**                                              | `https://storyme-demo.vercel.app`               | CORS allowlist, comma-separated for multiple origins (e.g. preview + production Vercel URLs). Must match the web app's deployed origin exactly.                                                                                                                                                                                                                            |
| `EMAIL_PROVIDER`                                                                                                             | API          | No (defaults to `console`)                           | `console` \| `resend`                           | Set to `resend` to send real verification/reset email; leaving it unset logs the link server-side instead (`ConsoleEmailService`) — fine for an internal/trusted demo, not for real users.                                                                                                                                                                                 |
| `RESEND_API_KEY`                                                                                                             | API          | **Yes, if `EMAIL_PROVIDER=resend`**                  | `re_...`                                        | Boot fails fast (env validation) if `EMAIL_PROVIDER=resend` is set without this.                                                                                                                                                                                                                                                                                           |
| `EMAIL_FROM`                                                                                                                 | API          | **Yes, if `EMAIL_PROVIDER=resend`**                  | `StoryMe <noreply@storyme.app>`                 | Must be a verified sender/domain in the Resend dashboard, or sends will fail at request time even though boot succeeds.                                                                                                                                                                                                                                                    |
| `EMAIL_REPLY_TO`                                                                                                             | API          | No                                                   | `support@storyme.app`                           | Optional; omitted from the outbound email entirely when unset.                                                                                                                                                                                                                                                                                                             |
| `OPENAI_API_KEY`                                                                                                             | API          | Only if using real generation                        | `sk-...`                                        | Required only when `STORY_GENERATION_PROVIDER=openai` or `IMAGE_GENERATION_PROVIDER=openai`. Leave the providers on `mock` (default) for a free/deterministic demo.                                                                                                                                                                                                        |
| `STORY_GENERATION_PROVIDER`                                                                                                  | API          | No (defaults to `mock`)                              | `mock` \| `openai`                              | Set to `openai` only if you want real story text and have budget.                                                                                                                                                                                                                                                                                                          |
| `IMAGE_GENERATION_PROVIDER`                                                                                                  | API          | No (defaults to `mock`)                              | `mock` \| `openai`                              | Same — real image generation costs money per call (see `REAL_GENERATION_MAX_PAGES` guardrail).                                                                                                                                                                                                                                                                             |
| `PDF_STORAGE_DRIVER`                                                                                                         | API          | **Yes, set to `r2` or `s3`**                         | `r2`                                            | Do not leave as default `local` — the container filesystem is ephemeral on every host in this runbook, so previously generated PDFs disappear on redeploy/restart.                                                                                                                                                                                                         |
| `IMAGE_STORAGE_DRIVER`                                                                                                       | API          | **Yes, set to `r2` or `s3`**                         | `r2`                                            | Same reasoning as `PDF_STORAGE_DRIVER`, same ephemeral-filesystem risk for generated images.                                                                                                                                                                                                                                                                               |
| `PDF_STORAGE_BUCKET`                                                                                                         | API          | **Yes** (if using cloud storage)                     | `storyme-demo-previews`                         | Shared by both PDF and image storage (images go under an `images/` key prefix in the same bucket).                                                                                                                                                                                                                                                                         |
| `PDF_STORAGE_REGION`                                                                                                         | API          | **Yes** (if using cloud storage)                     | `auto` (R2) or `us-east-1` (S3)                 | R2 always uses `auto`.                                                                                                                                                                                                                                                                                                                                                     |
| `PDF_STORAGE_ENDPOINT`                                                                                                       | API          | **Yes for R2**, omit for AWS S3                      | `https://<account-id>.r2.cloudflarestorage.com` | Only needed for R2 (or any non-AWS S3-compatible endpoint).                                                                                                                                                                                                                                                                                                                |
| `PDF_STORAGE_ACCESS_KEY_ID`                                                                                                  | API          | **Yes** (if using cloud storage)                     | `<r2-or-iam-access-key>`                        | Scope the credential to only this bucket if the provider supports it.                                                                                                                                                                                                                                                                                                      |
| `PDF_STORAGE_SECRET_ACCESS_KEY`                                                                                              | API          | **Yes** (if using cloud storage)                     | `<r2-or-iam-secret>`                            | Treat as a secret — set via the host's secret manager, not committed anywhere.                                                                                                                                                                                                                                                                                             |
| `PDF_STORAGE_PUBLIC_BASE_URL`                                                                                                | API          | No                                                   | _(not currently read by any code path)_         | Not present in `apps/api/src/config/env.schema.ts` or `pdf-storage.ts` today — PDFs are served through the API's own preview endpoint (`GET /api/books/:id/pdf/preview`), not a direct public bucket URL. Included here for completeness since the task template asked for it; there is nothing to set.                                                                    |
| `WEB_APP_URL`                                                                                                                | API          | **Yes**                                              | `https://storyme-demo.vercel.app`               | Used only to build links in verification/reset email; set to the deployed web origin, not `localhost`.                                                                                                                                                                                                                                                                     |
| `ENABLE_GENERATION_WORKER`                                                                                                   | API + worker | No (leave unset/`false` on both deployed services)   | `false`                                         | Local single-process dev convenience only (`pnpm --filter @book/api dev` self-enables the processor). Never set `true` on a deployed **api** service — it would double-consume jobs alongside the dedicated worker service. The dedicated **worker** entrypoint (`worker.ts`) always registers the processor regardless of this var, so it doesn't need it set either.     |
| `STRIPE_BILLING_ENABLED`                                                                                                     | API          | No (defaults to `false`; optional feature)           | `false` \| `true`                               | Credit purchases (Phase E3/E4) are opt-in. `false` (default): `POST /api/billing/checkout` fails closed with `BILLING_DISABLED`, no Stripe client ever constructed, `/dashboard/credits` shows an unavailable state. Set `true` only once every var below is also set — see [§3.3 Stripe webhook configuration](#stripe-webhook-configuration-and-test-mode-verification). |
| `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` / `STRIPE_PRICE_ID_STARTER` / `STRIPE_PRICE_ID_PRO` / `STRIPE_PRICE_ID_BUNDLE` | API          | **Yes, if `STRIPE_BILLING_ENABLED=true`**            | `sk_test_...` / `whsec_...` / `price_...`       | Boot fails fast (env validation, `env.schema.ts` `superRefine`) if `STRIPE_BILLING_ENABLED=true` is set without all five. Use **test-mode** keys/Price IDs for a private demo — see [§3.3](#stripe-webhook-configuration-and-test-mode-verification).                                                                                                                      |
| `NEXT_PUBLIC_API_URL`                                                                                                        | Web          | **Yes**                                              | `https://storyme-api-demo.onrender.com/api`     | Baked in at **build time** (Next.js inlines `NEXT_PUBLIC_*` at build), not read at request time — must be set in Vercel's project env vars _before_ the first build, and changing it requires a rebuild. Include the `/api` suffix.                                                                                                                                        |
| `NEXT_PUBLIC_AUTH_MODE`                                                                                                      | Web          | No (defaults to `jwt`, recommended for this runbook) | `dev` \| `jwt`                                  | Same build-time-inlined caveat as `NEXT_PUBLIC_API_URL`. Must match the API's `AUTH_MODE` exactly.                                                                                                                                                                                                                                                                         |

Vars not covered above (`GOOGLE_*`, `ANTHROPIC_API_KEY`, `FAL_API_KEY`,
`R2_ACCOUNT_ID`/`R2_*`) are optional and reserved for features not built yet
— see `.env.example` for the full annotated list. They can be left unset.
`STRIPE_*` is a separate case: the _feature_ (one-time credit purchases) is
built and shipped (Phase E3/E4) — these vars are optional only because the
feature itself is opt-in via `STRIPE_BILLING_ENABLED`, not because anything
is unbuilt. See the table rows above.

### 3.1 Tiered checklist {#env-tiers}

The matrix above is the authoritative per-var reference; this is the same
information regrouped as three literal checklists so a deploy operator can
tell at a glance which tier a given var falls in.

**Required for this private demo:**

- [ ] `DATABASE_URL` — managed Postgres.
- [ ] `REDIS_URL` — required to boot and pass `/api/health`, see
      [Is Redis required?](#is-redis-required).
- [ ] `JWT_SECRET` / `JWT_REFRESH_SECRET` — 32+ char random hex each.
- [ ] `AUTH_MODE=jwt` (API) / `NEXT_PUBLIC_AUTH_MODE=jwt` (web) — must match.
- [ ] `ALLOWED_ORIGINS` — the web app's exact deployed origin.
- [ ] `WEB_APP_URL` — used to build links in verification/reset email; set to
      the deployed web origin so those links point at the real app, not
      `localhost`.
- [ ] `NEXT_PUBLIC_API_URL` — the deployed API's public URL, **including the
      `/api` suffix**, set before the web app's first build.
- [ ] `PDF_STORAGE_DRIVER=r2` (or `s3`) and `IMAGE_STORAGE_DRIVER=r2` (or
      `s3`) plus `PDF_STORAGE_BUCKET`/`PDF_STORAGE_REGION`/
      `PDF_STORAGE_ACCESS_KEY_ID`/`PDF_STORAGE_SECRET_ACCESS_KEY`
      (`PDF_STORAGE_ENDPOINT` for R2) — see
      [Storage decision](deployment-readiness.md#storage-decision). Only
      optional if the demo host has a genuinely persistent filesystem and
      restarts are acceptable to lose PDFs/images over — not true of any host
      recommended in [§2](#2-recommended-provider-path).

**Optional for local/dev (safe to leave unset or at their defaults):**

- `AUTH_MODE` / `NEXT_PUBLIC_AUTH_MODE` — default to `jwt` already.
- `EMAIL_PROVIDER` — defaults to `console` (logs the link instead of
  sending); fine for a trusted-operator private demo.
- `STORY_GENERATION_PROVIDER` / `IMAGE_GENERATION_PROVIDER` — default
  to `mock`, deterministic, no network calls, no cost.
- `AUTH_RATE_LIMIT_WINDOW_MS` / `AUTH_RATE_LIMIT_MAX_ATTEMPTS` — sane
  defaults (15 min / 10 attempts).
- `PORT` — most hosts set this automatically.

**Required before real public traffic (beyond this private-demo runbook):**

- [ ] `EMAIL_PROVIDER=resend` plus `RESEND_API_KEY` and `EMAIL_FROM` — real
      users need real verification/reset email, not a server-side log line.
- [ ] `prisma migrate deploy` wired into an actual release pipeline instead
      of being run by hand — the approval-protected
      [`.github/workflows/migrate.yml` workflow](#phase-f3-migration-workflow)
      now exists for this, but still requires a repository administrator to
      configure the `staging`/`production` GitHub Environments (see
      [§5a.2](#f3-required-environment-configuration)) before a real run can
      succeed — see [§5 Migration and release order](#5-migration-and-release-order).

  (The Redis-backed rate limiter this checklist previously asked for is
  already done — `RATE_LIMITER_TOKEN` resolves to `RedisRateLimiter`
  unconditionally, safe across multiple API instances; see
  [Security notes](#security-notes).)

### 3.2 Environment ownership matrix {#env-ownership-matrix}

Which process actually reads each var — useful when the API and worker are
two separate deployed services with their own env var panels, and it's easy
to set something on the wrong one (or forget the other).

| Var group                                                                  | API (`main.ts`)                                                                          | Worker (`worker.ts`)                                                                                                                                                     | Web                                                        |
| -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------- |
| `DATABASE_URL`, `REDIS_URL`                                                | Required                                                                                 | Required                                                                                                                                                                 | —                                                          |
| `JWT_SECRET`, `JWT_REFRESH_SECRET`, `AUTH_MODE`                            | Required                                                                                 | Not read (worker has no HTTP surface, mints/verifies no tokens)                                                                                                          | `NEXT_PUBLIC_AUTH_MODE` only, must match API's `AUTH_MODE` |
| `ALLOWED_ORIGINS`                                                          | Required (CORS)                                                                          | Not read                                                                                                                                                                 | —                                                          |
| `WEB_APP_URL`                                                              | Required (email link building)                                                           | Not read                                                                                                                                                                 | —                                                          |
| `PDF_STORAGE_*` / `IMAGE_STORAGE_*`                                        | Required (serves previews)                                                               | Required (renders + saves PDFs/images) — **must be set identically on both**, see [PDF storage: separate worker guard](deployment-readiness.md#pdf-storage-worker-guard) | —                                                          |
| `EMAIL_PROVIDER`, `RESEND_API_KEY`, `EMAIL_FROM`                           | Required (verification/reset emails)                                                     | Not read                                                                                                                                                                 | —                                                          |
| `STORY_GENERATION_PROVIDER`, `IMAGE_GENERATION_PROVIDER`, `OPENAI_API_KEY` | Not read at runtime (only the worker actually calls a generation provider)               | Required if either provider is `openai`                                                                                                                                  | —                                                          |
| `STRIPE_*`                                                                 | Required if `STRIPE_BILLING_ENABLED=true` (checkout + webhook endpoints live on the API) | Not read                                                                                                                                                                 | —                                                          |
| `ENABLE_GENERATION_WORKER`                                                 | Read, but must stay unset/`false` on a deployed **api** service                          | Not read (worker always registers the processor)                                                                                                                         | —                                                          |
| `NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_AUTH_MODE`                             | —                                                                                        | —                                                                                                                                                                        | Required (build-time)                                      |

A var marked "Not read" is safe to leave unset on that service even if it's
required on the other — setting it anyway is harmless (just noise), but
omitting it from the _required_ service is a boot failure or a silent
misconfiguration depending on the var (see the [preflight
command](#pre-deploy-preflight-check) below, which exists specifically to
catch the silent cases before they reach production).

### 3.3 Stripe webhook configuration and test-mode verification {#stripe-webhook-configuration-and-test-mode-verification}

Only relevant if this deployment sets `STRIPE_BILLING_ENABLED=true`. Skip
entirely for a demo that only exercises the schema-default starter credits.

1. **Create test-mode Products/Prices** in the Stripe dashboard (Test mode
   toggle, top right) — one-time (not recurring) Price for each of the three
   catalog packages (`apps/api/src/billing/billing-packages.ts`: `starter` =
   10 credits, `pro` = 30 credits, `bundle` = 100 credits). Copy each Price
   ID into `STRIPE_PRICE_ID_STARTER` / `STRIPE_PRICE_ID_PRO` /
   `STRIPE_PRICE_ID_BUNDLE`.
2. **Create the webhook endpoint**: Stripe dashboard → Developers → Webhooks
   → Add endpoint, URL `https://<your-api-host>/api/billing/webhook`, event
   `checkout.session.completed` only (every other event type is a no-op
   `2xx` in this codebase). Copy the endpoint's **Signing secret** into
   `STRIPE_WEBHOOK_SECRET`.
3. **Copy the test-mode secret key** (Developers → API keys, Test mode) into
   `STRIPE_SECRET_KEY` — starts with `sk_test_`, never `sk_live_` for this
   runbook.
4. **Verify signature verification actually works** before trusting real
   traffic: from a machine with the [Stripe
   CLI](https://stripe.com/docs/stripe-cli) and network access to the
   deployed API, `stripe listen --forward-to
https://<your-api-host>/api/billing/webhook` and `stripe trigger
checkout.session.completed` — confirm the API logs show the event
   accepted (not a `400` signature-verification failure) and, for a session
   whose metadata matches a real user/package, a credit grant.
5. **End-to-end test-mode purchase**: from the deployed web app, sign in,
   go to `/dashboard/credits`, buy a package using [Stripe's test
   card](https://stripe.com/docs/testing) `4242 4242 4242 4242` (any future
   expiry, any CVC) — confirm redirect to `/billing/success`, the balance
   updates, and a `CreditTransaction` row exists. This is the exact flow the
   [smoke test checklist](#6-smoke-test-checklist) below also covers.

### 3.4 Pre-deploy preflight check {#pre-deploy-preflight-check}

Before setting any of the above on a real host, validate the _combination_
locally against a `.env` file (or an exported shell environment) shaped like
the target deployment:

```bash
pnpm --filter @book/api preflight:deploy --role=api
pnpm --filter @book/api preflight:deploy --role=worker
```

Run **both** roles — the api/worker env ownership split above means a
combination that's valid for one role can be invalid for the other (e.g. a
missing `RESEND_API_KEY` only fails the api role, since the worker never
reads `EMAIL_PROVIDER` at all; a local storage driver fails both, since both
processes read `PDF_STORAGE_*`/`IMAGE_STORAGE_*`). Validation-only, no
network calls, and never prints a secret value — see
`apps/api/scripts/preflight-deploy.ts` for exactly which invariants it
checks. A clean exit (`0`) does not replace the [smoke test
checklist](#6-smoke-test-checklist) below — it only catches cross-setting
config mistakes _before_ a container starts, not runtime/network issues
(wrong credentials that parse fine but don't authenticate, an unreachable
host, etc.).

## 4. Setup order

Run these in order — each step depends on state from the one before it.

### Step 1 — Provision Postgres

Create the managed Postgres instance (Neon/Supabase/host add-on). Note the
connection string for `DATABASE_URL`.

### Step 2 — Provision Redis

Create the smallest managed Redis instance (Upstash/Redis Cloud/host
add-on). Note the connection string for `REDIS_URL`. See
[Is Redis required?](#is-redis-required) if this step feels skippable — it
isn't: both boot/health checks and every generation run depend on it.

### Step 3 — Provision the storage bucket

Create an R2 (or S3) bucket. Note the bucket name, region, endpoint (R2
only), and an access key/secret scoped to it. This single bucket is shared
by both `PDF_STORAGE_*` and image storage.

### Step 4 — Configure API env vars

Set every "Required for private demo? Yes" row from the
[env var matrix](#3-environment-variable-matrix) on the API host, using the
values from steps 1–3.

### Step 5 — Build the API image

From the repo root (the build context must be the repo root, not
`apps/api/`, since the Dockerfile copies root-relative workspace manifests):

```bash
docker build -f apps/api/Dockerfile -t storyme-api:demo .
```

Most Docker-native hosts (Render, Fly, Railway) build this directly from the
repo + Dockerfile path — you likely won't run this command locally, just
point the platform at `apps/api/Dockerfile` with build context `.` (repo
root).

### Step 6 — Run migrations (separate step, not inside the container)

```bash
pnpm --filter @book/api prisma:migrate:deploy
```

Run this **from a machine/CI job with network access to the production
`DATABASE_URL`**, before the new API version starts serving traffic. The
Docker image deliberately does not run this — see
[Migration and release order](#5-migration-and-release-order) below for why.

### Step 7 — Start the API and verify health

Start the container (the platform does this automatically after step 5 on
Render/Fly/Railway; shown here as a manual `docker run` for reference):

```bash
docker run -d --name storyme-api-demo -p 4000:4000 \
  -e DATABASE_URL="postgresql://<user>:<pass>@<host>:5432/<db>" \
  -e REDIS_URL="redis://<user>:<pass>@<host>:6379" \
  -e JWT_SECRET="$(openssl rand -hex 32)" \
  -e JWT_REFRESH_SECRET="$(openssl rand -hex 32)" \
  -e ALLOWED_ORIGINS="https://<your-vercel-app>.vercel.app" \
  -e PDF_STORAGE_DRIVER="r2" \
  -e IMAGE_STORAGE_DRIVER="r2" \
  -e PDF_STORAGE_BUCKET="<bucket>" \
  -e PDF_STORAGE_REGION="auto" \
  -e PDF_STORAGE_ENDPOINT="https://<account-id>.r2.cloudflarestorage.com" \
  -e PDF_STORAGE_ACCESS_KEY_ID="<key>" \
  -e PDF_STORAGE_SECRET_ACCESS_KEY="<secret>" \
  storyme-api:demo
```

Verify:

```bash
curl https://<your-api-host>/api/health
# {"status":"ok","info":{"db":{"status":"up"},"redis":{"status":"up"}},...}
```

If this doesn't return `200`/`"status":"ok"`, do not proceed to step 7a —
fix DB/Redis connectivity first (check `db`/`redis` sub-status in the
response body to tell which one is failing).

### Step 7a — Deploy the generation worker {#4a-deploy-the-generation-worker}

A second Docker service, built from the **same image** as the API (same
`apps/api/Dockerfile`, same build context) but with a different start
command and a distinct env panel — see [§3.2 Environment ownership
matrix](#env-ownership-matrix) for exactly which vars it needs.

```bash
docker run -d --name storyme-worker-demo \
  -e DATABASE_URL="postgresql://<user>:<pass>@<host>:5432/<db>" \
  -e REDIS_URL="redis://<user>:<pass>@<host>:6379" \
  -e PDF_STORAGE_DRIVER="r2" \
  -e IMAGE_STORAGE_DRIVER="r2" \
  -e PDF_STORAGE_BUCKET="<bucket>" \
  -e PDF_STORAGE_REGION="auto" \
  -e PDF_STORAGE_ENDPOINT="https://<account-id>.r2.cloudflarestorage.com" \
  -e PDF_STORAGE_ACCESS_KEY_ID="<key>" \
  -e PDF_STORAGE_SECRET_ACCESS_KEY="<secret>" \
  storyme-api:demo node dist/worker
```

(`storyme-api:demo` is the same image tag built in [Step
5](#step-5--build-the-api-image); only the container command changes —
`node dist/worker` instead of the image's default `CMD`. On Render/Fly/
Railway, this is a second service pointed at the same Dockerfile/image with
its start command overridden to `node dist/worker`
(`pnpm --filter @book/api start:prod:worker` locally).)

**Ordering constraint — deploy the API before (or atomically with) the
worker, never the worker first.** The worker consumes `GenerationRun`/
`OutboxEvent` rows and `PDF_STORAGE_*`/`IMAGE_STORAGE_*` config that the API
process defines the shape of (schema migrations from [Step
6](#step-6--run-migrations-separate-step-not-inside-the-container) must
already be applied, which they are by this point in the ordered list) — a
worker started against a not-yet-migrated database, or with
`PDF_STORAGE_DRIVER`/`IMAGE_STORAGE_DRIVER` set differently than the API
(see [PDF storage: separate worker guard](deployment-readiness.md#pdf-storage-worker-guard)),
produces exactly the "book claims `complete` but preview 404s" incident that
guard exists to prevent. Both processes are otherwise safe to run at
mismatched versions briefly during a rolling deploy — they communicate only
through the database and the BullMQ queue, never a direct API call to each
other — but the worker must never be _ahead_ of the API on schema or storage
config.

**Verify the worker actually started** (it has no HTTP endpoint to `curl`,
so check logs instead):

```bash
docker logs storyme-worker-demo
# expect: "Generation worker started — consuming book-generation jobs (no HTTP server)."
```

If `assertPdfStorageSupportsWorker`'s guard fires instead (a clear thrown
error naming every required `PDF_STORAGE_*` var), the worker's
`PDF_STORAGE_DRIVER` is `local` (or unset) while `NODE_ENV=production` —
fix the worker's storage env vars to match the API's before retrying.

### Step 8 — Configure Web env vars

Set `NEXT_PUBLIC_API_URL` in the Vercel project's environment variables to
the API host's public URL **including the `/api` suffix**
(e.g. `https://storyme-api-demo.onrender.com/api`) — before the first build.

### Step 9 — Build/deploy Web

```bash
pnpm --filter @book/web build
```

On Vercel this happens automatically on push/deploy once the project is
connected and `NEXT_PUBLIC_API_URL` is set — there is no separate start
command to configure there (Vercel serves the build output itself). For a
self-hosted Node host, follow the build with:

```bash
pnpm --filter @book/web start
```

### Step 10 — Run the smoke test

See [Smoke test checklist](#6-smoke-test-checklist) below.

## 5. Migration and release order

```
1. provision Postgres
2. provision bucket/storage
3. configure API env vars
4. build API image
5. run `prisma migrate deploy`
6. start API
7. verify /api/health
7a. deploy the generation worker (same image, after the API — never before)
8. configure web env vars
9. build/deploy web
10. run smoke test
```

**The worker must never start before the API/migrations on a first deploy.**
It reads the same schema and depends on `PDF_STORAGE_*`/`IMAGE_STORAGE_*`
being configured identically to the API — see [Step 7a's ordering
constraint](#4a-deploy-the-generation-worker) for the full reasoning. On a
routine redeploy (not first deploy), API and worker can roll out in either
order or concurrently as long as neither's storage/schema config diverges
from the other mid-rollout.

**Migrations must never run inside the app process or the container's
`CMD`.** `apps/api/Dockerfile`'s `CMD` is `node dist/main` only —
intentionally, so that:

- A container that fails to start doesn't leave the database in a
  half-migrated state.
- Multiple container replicas (if ever introduced) don't race to apply the
  same migration concurrently.
- Migration failures surface as a distinct, visible release-step failure
  rather than being buried in application boot logs.

Run `pnpm --filter @book/api prisma:migrate:deploy` from CI or a one-off
release-step job with network access to the production database, and only
start/restart the API container after it succeeds. **This is now available as
a dedicated, approval-protected GitHub Actions workflow** — see
[§5a below](#phase-f3-migration-workflow) — instead of running the command by
hand from a local machine.

## 5a. Manual migration release workflow (Phase F3) {#phase-f3-migration-workflow}

Phase F2 ([deployment-readiness.md](deployment-readiness.md#phase-f2-ci))
proved migrations apply cleanly in CI against a throwaway database, but
deliberately left the real staging/production release hook unwired — see
that phase's "CI migration verification vs. a real release migration hook"
section. Phase F3 closes that gap with
**`.github/workflows/migrate.yml`** ("Database Migration (Manual)",
job `Apply Database Migrations`): a `workflow_dispatch`-only workflow that
runs `pnpm --filter @book/api prisma:migrate:deploy` against a selected
staging or production database, gated by GitHub Environment protection and an
explicit target-identity guard.

**This workflow owns database migration only.** It never deploys the API,
worker, or web app, and never touches Stripe/storage/email configuration —
those remain separate, existing deploy steps (see [§4](#4-setup-order) and
[§7a](#4a-deploy-the-generation-worker) above). **Adding this workflow to the
repository does not by itself configure any secret, reviewer, or deploy
anything** — every item in [§5a.2](#f3-required-environment-configuration)
below must be configured by a repository administrator before a real run can
succeed.

### §5a.1 How to run it

1. GitHub → **Actions** → **Database Migration (Manual)** → **Run workflow**.
2. Choose the branch/tag to run from (production requires `main` — see
   [§5a.2](#f3-required-environment-configuration)).
3. Fill in the inputs:
   - **target_environment**: `staging` or `production`.
   - **confirmation**: the exact phrase for that environment (case-sensitive,
     no surrounding whitespace) — see [§5a.3](#f3-confirmation-phrases).
   - **release_note** (optional): a short note for the audit trail, 500
     characters or fewer.
4. Run it. If the target GitHub Environment has required reviewers
   configured, the run pauses for approval before the job starts — see
   [§5a.2](#f3-required-environment-configuration).
5. Read the job's **Step Summary** (or the job logs) for the outcome —
   environment, commit SHA, workflow run ID, success/failure, and the
   reminder to deploy the API before the worker next. It never contains a
   hostname, database name, or credential.

### §5a.2 Required GitHub Environment configuration {#f3-required-environment-configuration}

The workflow dynamically binds its job to a GitHub Environment named exactly
`staging` or `production` (whichever the operator selects) — this is what
actually enforces reviewer approval and branch restriction, and the workflow
has no way to enforce it itself if it's missing. **A repository administrator
must create both Environments (Settings → Environments) and configure, for
each:**

| Setting                                                  | `staging`                                                                                                  | `production`                                                                                                                                                                                                                  |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Environment secret `DATABASE_URL`                        | **Required** — the staging database's connection string.                                                   | **Required** — the production database's connection string. **Never** a repository-wide secret — see below.                                                                                                                   |
| Environment variable (or secret) `MIGRATION_DB_HOSTNAME` | **Required** — the expected staging DB hostname, used only for the guard's identity check (never printed). | **Required** — the expected production DB hostname.                                                                                                                                                                           |
| Environment variable (or secret) `MIGRATION_DB_NAME`     | **Required** — the expected staging database name.                                                         | **Required** — the expected production database name.                                                                                                                                                                         |
| Required reviewers                                       | Optional, recommended.                                                                                     | **Strongly recommended** — without at least one required reviewer, a run with a valid confirmation phrase applies immediately once dispatched.                                                                                |
| Deployment branch restriction                            | Optional.                                                                                                  | **Required: restrict to `main`.** The target-identity guard also independently rejects a production run whose triggering ref isn't `main` — this is defense in depth, not a substitute for the Environment-level restriction. |

**`DATABASE_URL` must be an _Environment_ secret scoped to `staging` or
`production` individually — never a repository-level secret.** A
repository-level `DATABASE_URL` would be visible to (and usable from) either
environment binding, defeating the whole point of separating the two. The
same applies to `MIGRATION_DB_HOSTNAME`/`MIGRATION_DB_NAME`: they must be
scoped to the same environment as the `DATABASE_URL` they describe, or the
guard is comparing against the wrong environment's expected identity.

If any of the above is not yet configured, this workflow either fails at the
target guard step (missing `MIGRATION_DB_HOSTNAME`/`MIGRATION_DB_NAME`) or
fails to connect (missing/wrong `DATABASE_URL`) — it does not silently
proceed against an unconfigured or wrong target.

### §5a.3 Confirmation phrases {#f3-confirmation-phrases}

- **staging**: `APPLY_STAGING_MIGRATIONS`
- **production**: `APPLY_PRODUCTION_MIGRATIONS`

Each phrase is valid for its own environment only — submitting the staging
phrase against a `production` run (or vice versa) is rejected, both by the
workflow's fast pre-install gate and, redundantly, by the target-identity
guard script. See `CONFIRMATION_PHRASES` in
`apps/api/src/config/migration-target-guard.ts` for the source of truth these
values must stay in sync with.

### §5a.4 What the target-identity guard checks

Before `prisma migrate status` or `prisma migrate deploy` ever runs, the
workflow runs `pnpm --filter @book/api migrate:target-guard`
(`apps/api/scripts/migrate-target-guard.ts`, logic in
`apps/api/src/config/migration-target-guard.ts`), which:

- Requires `DATABASE_URL` to parse as a `postgresql://`/`postgres://` URL.
- Rejects an empty, malformed, `localhost`, or loopback (`127.0.0.1`, `::1`,
  `0.0.0.0`) host outright, regardless of what's "expected".
- Compares the URL's actual hostname and database name against
  `MIGRATION_DB_HOSTNAME`/`MIGRATION_DB_NAME` for the selected environment.
- Re-checks the confirmation phrase against the selected environment.
- For `production`, requires the triggering ref to be exactly `main`.
- **Never prints** `DATABASE_URL`, or any hostname/database name/username/
  password/query parameter derived from it — only stable check codes and
  generic corrective instructions. Safe to run against a real production
  `DATABASE_URL` and log the result.

Any single mismatch exits non-zero and stops the workflow before Prisma runs;
see `apps/api/src/config/migration-target-guard.spec.ts` for the full test
matrix (valid/invalid staging and production targets, wrong/swapped
confirmation phrases, malformed and non-Postgres URLs, localhost/loopback
rejection, hostname/database-name mismatches, missing expected-identity
config, and URL-encoded-password handling).

### §5a.5 Rollback guidance

Same rule as [§7 Rollback notes](#7-rollback-notes) below: **`prisma migrate
deploy` only applies forward migrations — this workflow has no rollback
mode, and a rollback must never revert an already-applied migration.** If a
bad migration reaches staging or production, write and apply a new forward
migration that undoes the change (a new PR + a new run of this workflow);
never hand-edit `_prisma_migrations` or attempt to run an old migration
backwards. Rolling the API/worker back to a pre-migration image is safe only
if the migration was purely additive (new nullable column, new table) — a
breaking migration (dropped/renamed column an older image still reads) needs
a forward fix-up migration first, not just an image rollback.

### §5a.6 Incident procedure: a failed migration run

1. Read the failed job's logs and Step Summary — the failure is one of:
   confirmation/target-guard rejection (nothing touched the database), a
   `prisma migrate status`/`prisma migrate deploy` connection failure
   (nothing applied), or a genuine migration error partway through
   `prisma migrate deploy` (Prisma's own migration history table records
   exactly which migration failed and stops there — it does not silently
   skip ahead).
2. **Do not re-run the workflow expecting an automatic retry** — it never
   retries a failed migration for you (see [Failure behavior](#f3-failure-behavior)
   below); diagnose the root cause from the preserved Prisma output first.
3. **Do not attempt rollback SQL** and do not hand-edit
   `_prisma_migrations`. If the failure was a genuine schema/data problem,
   write a new forward migration that fixes it and run this workflow again
   once that migration is merged to the branch this environment allows
   (`main` for production).
4. Once the migration history is clean again (`prisma migrate status`
   reports no pending migrations and no failed migration), proceed with the
   normal rollout order: API, then worker, then web — see
   [§5](#5-migration-and-release-order) above.
5. The full audit trail — who ran it, which environment, which commit, the
   confirmation phrase's environment (never its raw value beyond pass/fail),
   and every step's output — lives in the GitHub Actions run itself
   (**Actions → Database Migration (Manual)**, then the specific run), plus
   that run's Step Summary. Nothing about a run is logged anywhere else.

### Failure behavior {#f3-failure-behavior}

- Target validation, migration deployment, and post-deploy verification never
  use `continue-on-error` — any failure in one of those three steps stops the
  job there.
- No step retries a failed migration automatically.
- No step attempts rollback SQL.
- A failure always stops before any application deployment step — there is
  no API/worker/web deployment step in this workflow to begin with.
- `DATABASE_URL` is passed only via step `env:` blocks, never echoed, and
  never assembled into a dynamic shell string; Prisma's own diagnostic output
  is preserved (not suppressed) so a real failure is still diagnosable from
  the job logs, without ever printing the connection string itself.

## 6. Smoke test checklist

Run this after step 10, and again after any redeploy. Use a throwaway email
address you control (or a `+alias` on one you own) — this checklist creates
a real account.

### Boot / health

- [ ] `curl https://<your-api-host>/api/health` returns `200` with
      `"status":"ok"` and both `db`/`redis` sub-statuses `up` (see
      [Step 7](#step-7--start-the-api-and-verify-health) above).
- [ ] Open the web app's landing page (`/`) — loads without console errors.

### Auth: register → verify → login → logout

- [ ] Navigate to `/register`, create a new account (email + password, 8+
      chars with 1 uppercase and 1 number). Confirm it redirects straight
      into `/dashboard` already signed in (registration auto-signs in, even
      though the account is unverified).
- [ ] Confirm a verification link was produced: with
      `EMAIL_PROVIDER=resend`, check the inbox for the registered address;
      with the default `EMAIL_PROVIDER=console`, check the API's server logs
      for the `[ConsoleEmailService] Verification email for <email>: ...`
      line instead.
- [ ] Open the verification link and confirm the account is marked verified.
- [ ] Click **Log out** in the dashboard header.
- [ ] Log back in at `/login` with the same credentials — confirm this now
      succeeds (a login attempt before verifying would have failed with
      `401 EMAIL_NOT_VERIFIED`).

### Credits: purchase → webhook grant (only if `STRIPE_BILLING_ENABLED=true`)

Skip this whole subsection for a deployment that leaves billing disabled —
the schema-default starter balance (`User.credits` = 3) is enough to run the
rest of this checklist once. See [§3.3 Stripe webhook
configuration](#stripe-webhook-configuration-and-test-mode-verification) for
one-time setup before this point.

- [ ] Navigate to `/dashboard/credits` — confirm the current balance and the
      three package cards render (not the "billing unavailable" state).
- [ ] Buy the smallest package using [Stripe's test
      card](https://stripe.com/docs/testing) `4242 4242 4242 4242` (any
      future expiry, any CVC).
- [ ] Confirm redirect to `/billing/success`, and that it resolves to a
      granted state (not stuck "pending") within its polling window.
- [ ] Confirm the balance on `/dashboard/credits` increased by exactly the
      purchased package's credit amount, and the new `CreditTransaction`
      appears in the paginated history with `reason: purchase`.
- [ ] Tail the API logs during this step and confirm `POST
/api/billing/webhook` was received and returned `2xx` — this is the
      concrete proof the webhook URL/secret configured in
      [§3.3](#stripe-webhook-configuration-and-test-mode-verification) is
      correct, not just that the checkout redirect worked.

### Book creation and generation

- [ ] Navigate to `/dashboard`.
- [ ] Note the current credit balance (`/dashboard/credits` if billing is
      enabled, otherwise the schema-default `3`).
- [ ] Click **Create Your First Book**, fill in the 3-step wizard, submit.
- [ ] Confirm redirect to the new book's detail page with status `created`.
- [ ] Click **Generate Story**; confirm the page polls and progresses through
      pipeline stages (`char_build` → … → `complete`).
- [ ] Confirm the balance dropped by exactly 1 credit the moment generation
      was scheduled (not when it completed) — proves `BooksService.createRunAndSchedule`'s
      atomic charge is wired, not just the UI.
- [ ] Confirm the generated story preview (story plan, page plan, draft
      text, images) renders on the detail page.
- [ ] Once `complete`, click **Open PDF** — confirm it opens
      `GET /api/books/:id/pdf/preview` in a new tab and renders.
- [ ] Click **Download PDF** — confirm a file downloads.
- [ ] **Cloud storage durability check**: restart the API container
      (`docker restart storyme-api-demo`, or trigger a redeploy on the
      platform), then reload the book detail page and re-open/re-download
      the PDF — confirm it still works. This is the check that actually
      proves `PDF_STORAGE_DRIVER=r2`/`IMAGE_STORAGE_DRIVER=r2` is wired
      correctly; with the default `local` driver this step would fail.

### Failed-run refund

- [ ] Force one generation to fail — the simplest reliable way without real
      OpenAI credentials is temporarily stopping the worker container
      (`docker stop storyme-worker-demo`) right after clicking **Generate
      Story** on a second book, then waiting for `GenerationRunRecoveryService`'s
      periodic sweep to reconcile the abandoned `GenerationRun` against
      BullMQ's own state and mark it failed (`GENERATION_RUN_RECOVERY_INTERVAL_MS`
      / `RECOVERY_LEASE_MS` in `apps/api/src/agent/generation-run-recovery.service.ts`,
      default 60s / 5min — the older `GenerationJobRecoveryService`/
      `GENERATION_JOB_STALE_AFTER_MS` no longer marks `Book` failed at all,
      see that service's own doc comment), then restarting the worker.
- [ ] Confirm the book's status becomes `failed` and the detail page shows a
      failure state with **Retry generation**.
- [ ] Confirm the credit spent scheduling that run was refunded exactly
      once — the balance should be back to what it was before this book was
      created, and a second `CreditTransaction` (`reason:
refund_generation_failure`,
      `apps/api/src/agent/generation-run-coordinator.service.ts`) appears in
      the history alongside the original `reason: book_creation` debit.
- [ ] Click **Retry generation** and confirm it succeeds normally (charging
      1 credit again) with the worker back up.
- [ ] Click **Log out** to end this session before the next check.

### Auth: forgot password → reset → old password rejected

- [ ] On `/login`, click **Forgot password?**, submit the same email.
- [ ] Retrieve the reset link the same way as the verification link above
      (Resend inbox or `[ConsoleEmailService] Password reset email for
<email>: ...` in the server logs).
- [ ] Open the reset link, set a new password, confirm it succeeds.
- [ ] Log in at `/login` with the **new** password — confirm it succeeds.
- [ ] Attempt to log in with the **old** password — confirm it is rejected.
      (A password reset revokes all existing refresh tokens, so this also
      implicitly verifies any other open session from this account would
      now be logged out.)

### Logs

- [ ] With the app running in production mode (`NODE_ENV=production`), tail
      the API's logs while repeating a couple of the steps above (login,
      verification) and confirm no raw JWT, refresh token, verification
      token, or reset token value appears in the log output — only
      request/response metadata and the generic messages described in
      [Security notes](#security-notes) below.

## 7. Rollback notes

- **API**: redeploy the previous Docker image tag on the platform (Render/
  Fly/Railway all keep prior deploys/images available for rollback). No
  database changes are needed for a code-only rollback.
- **Worker**: redeploy the previous image tag on the worker service
  independently of the API — they're separate services from the same image,
  so rolling one back doesn't require rolling back the other. The only
  constraint (see [Step 7a's ordering
  note](#4a-deploy-the-generation-worker)) is that the worker's
  `PDF_STORAGE_*`/`IMAGE_STORAGE_*` config and the applied schema must never
  end up _ahead_ of what the API expects — rolling the worker back to an
  older image against an already-forward-migrated database is safe (the
  worker only ever reads/writes rows, never runs migrations itself).
- **Database**: `prisma migrate deploy` only applies forward migrations —
  there is no automated rollback command, and **a rollback must never revert
  an already-applied migration**. If a bad migration reaches production,
  write and apply a new forward migration that undoes the change; do not
  attempt to run an old migration backwards or hand-edit
  `_prisma_migrations`. This means an API/worker rollback to a pre-migration
  image can still leave the _database_ on the newer schema — only safe if
  the migration was additive (new nullable column, new table); a rollback
  after a breaking migration (dropped/renamed column an older image still
  reads) needs a forward fix-up migration first, not just an image rollback.
- **Web**: Vercel keeps prior deployments and supports instant rollback to
  any previous build via its dashboard/CLI — use that rather than
  re-running a build with an older commit.
- **Storage**: PDFs/images are additive (new generations write new keys);
  rolling back the API doesn't delete or corrupt previously stored files.
- **Stripe**: rolling back the API does not affect already-granted credits
  or Stripe's own webhook delivery retries — a webhook delivered against a
  rolled-back API version that can't yet handle it returns non-2xx and
  Stripe retries automatically (see [Phase E3 summary](deployment-readiness.md#phase-e3-stripe-checkout-credit-purchases)),
  so no manual replay is needed once the rollback completes.

## 8. Known limitations

Carried over from the underlying audit
([deployment-readiness.md — Known blockers](deployment-readiness.md#known-blockers)),
restated for this private-demo scope:

- **`AUTH_MODE=dev`/`DevAuthGuard` is not production-safe for public
  exposure** — real auth (`AUTH_MODE=jwt`, this runbook's default) closes
  that gap; dev mode remains only as a documented local/trusted-operator
  fallback (see the warning at the top of this doc). A real transactional
  email provider now exists (`EMAIL_PROVIDER=resend`, Phase 6H) but is
  opt-in — a deployment that leaves it unset still only logs verification/
  reset links locally via `ConsoleEmailService`, which is a private-demo-
  scoped limitation, not a code limitation.
- **Generation worker is its own deployable process** (`apps/api/src/worker.ts`,
  `ENABLE_GENERATION_WORKER=true`), separate from the API's `main.ts`. Since
  Phase 3K, generation itself is durable and safe across multiple instances
  of either process (BullMQ distributes jobs) — but
  `GenerationJobRecoveryService`'s startup sweep still runs independently on
  every instance's boot (safe, but redundant), and the default `local`
  storage drivers aren't shared across instances. This runbook still
  provisions a single always-on instance of each; revisit before enabling
  autoscaling/multiple replicas.
- **Redis is a hard runtime dependency, not just boot-time/health-check
  infrastructure** — see [Is Redis required?](#is-redis-required). It backs
  both the durable generation queue (Phase 3K) and the health check; don't
  skip provisioning it.
- ~~No payments/credits enforcement~~ **Superseded (Phases E1–E4).** Every
  generation run charges 1 credit atomically at scheduling time and refunds
  automatically on terminal failure (`CreditsService`,
  `BooksService.createRunAndSchedule`), and one-time Stripe Checkout credit
  purchases are implemented end-to-end (`POST /api/billing/checkout` + `POST
/api/billing/webhook`, plus the `/dashboard/credits` and
  `/billing/success`/`/billing/cancel` frontend) — see [§3.3 Stripe webhook
  configuration](#stripe-webhook-configuration-and-test-mode-verification)
  and the [Credits: purchase → webhook grant](#6-smoke-test-checklist) smoke
  check. Billing itself stays opt-in (`STRIPE_BILLING_ENABLED=false` by
  default) — a deployment that leaves it disabled only relies on the
  schema-default starter balance, which is a config choice, not a missing
  feature. Subscriptions, the Stripe customer portal, cancellation, and
  promotional codes remain unimplemented.
- **No cancellation or partial-completion flow** — `BookStatus.Cancelled`
  and `BookStatus.Partial` are reserved schema states with no code path
  that produces them yet.
- **Migrations are a manual/CI step, not wired into any specific deploy
  pipeline yet** — this runbook documents the command and where it fits in
  the order, but doesn't wire it into a specific platform's release-phase
  hook (Render's "pre-deploy command," Fly's `release_command`, etc.) since
  that's platform-specific and out of scope for this docs-only phase.

## 9. Security notes {#security-notes}

Operational rules for this deployment, beyond what's already enforced in
code. None of these require a code change — they're deploy-time discipline.

- **Do not use `EMAIL_PROVIDER=console` (the default) for a deployment with
  real users.** It logs the verification/reset link to the server's stdout
  instead of emailing it — fine for a trusted-operator private demo where
  the operator can read those logs, unsafe for anyone else since whoever can
  read the logs can complete anyone's verification/reset flow. Set
  `EMAIL_PROVIDER=resend` + `RESEND_API_KEY` + `EMAIL_FROM` once real users
  are involved.
- **Never let raw tokens reach logs.** The codebase already only persists
  hashes of verification/reset tokens (`User.emailVerificationTokenHash`,
  `User.passwordResetTokenHash`) and refresh tokens
  (`RefreshToken.tokenHash`) — the raw values exist only transiently
  (in the HTTP response/email body). Don't add logging (`console.log`,
  `Logger.debug`, request/response body loggers) that would print a raw
  token, access token, or password anywhere in a request path. The
  [smoke test checklist's Logs step](#6-smoke-test-checklist) above is the
  concrete check for this.
- **Use HTTPS on both the API and web origins in production.** The refresh
  cookie is `Secure` + `SameSite=None` only when `NODE_ENV=production`
  (`apps/api/src/auth/refresh-cookie.ts`) — over plain HTTP in production
  the browser would silently drop it, breaking session persistence, not
  just leaking it. Every host recommended in [§2](#2-recommended-provider-path)
  (Vercel, Render/Fly/Railway) provides HTTPS by default; don't disable it
  or terminate TLS somewhere the cookie's `Secure` flag would be violated.
- **Set `ALLOWED_ORIGINS` to the exact deployed web origin(s), nothing
  broader.** CORS is `credentials: true` (`apps/api/src/main.ts`), so a
  wildcard or overly broad origin list would let any matching site make
  authenticated requests using a logged-in user's cookies/token. Comma-
  separate only the specific origins actually in use (e.g. a production
  Vercel URL plus its preview-deployment URL), never `*`.
- **Rotate `JWT_SECRET`, `JWT_REFRESH_SECRET`, `RESEND_API_KEY`, and storage
  credentials immediately if any of them leak** (committed by accident,
  exposed in a log, shared over an insecure channel). Rotating
  `JWT_SECRET`/`JWT_REFRESH_SECRET` invalidates every existing access/
  refresh token — every signed-in user is logged out and must log back in;
  there is no graceful dual-secret rollover implemented today, so treat
  rotation as a deliberate, announced action, not a silent one.
- ~~Do not run more than one API instance without a shared rate limiter~~
  **Superseded.** `AuthRateLimitGuard` and the generation/child-photo/
  diagnostics guards now inject `RATE_LIMITER_TOKEN`, which resolves to a
  Redis-backed `RedisRateLimiter` unconditionally
  (`apps/api/src/rate-limit/rate-limit.module.ts`) — correct across multiple
  API instances already, not just the single instance this runbook
  provisions. See the superseded-reasoning note at
  [`docs/auth-architecture.md` §13.2](auth-architecture.md#132-why-in-memory-not-redis)
  for what changed and why this bullet used to say otherwise. Multiple API
  replicas are still not exercised by this runbook's setup steps (it
  provisions one instance), but rate limiting specifically is no longer the
  blocker for doing so — see [Known limitations](#8-known-limitations) above
  for what else still favors care before autoscaling (storage drivers,
  redundant recovery sweeps).

## 10. Vercel + Railway: concrete deployment configuration

A concrete instantiation of §§1–9 above for one specific pair of hosts:
**Railway** for the API (Docker service + managed Postgres + managed Redis)
and **Vercel** for the web app. Nothing here changes the architecture,
env var names, or security posture already documented above — this section
just pins down exact commands/settings for this one platform pair.

### 10.1 Railway (API)

The repo root now has [`railway.json`](../railway.json) (config-as-code, picked
up automatically once the Railway service is linked to this repo):

```json
{
  "$schema": "https://railway.app/railway.schema.json",
  "build": {
    "builder": "DOCKERFILE",
    "dockerfilePath": "apps/api/Dockerfile"
  },
  "deploy": {
    "healthcheckPath": "/api/health",
    "healthcheckTimeout": 300,
    "restartPolicyType": "ON_FAILURE",
    "restartPolicyMaxRetries": 3
  }
}
```

- **Root Directory**: set the Railway service's Root Directory to the
  **repo root** (not `apps/api`). `apps/api/Dockerfile` copies root-relative
  workspace manifests (`pnpm-workspace.yaml`, `packages/types/package.json`,
  etc.), so the Docker build context must be the monorepo root — same
  constraint as the existing `docker build -f apps/api/Dockerfile .` command
  in [§4 Step 5](#step-5--build-the-api-image) above.
- **Build command**: none to set — Railway builds `apps/api/Dockerfile`
  directly (`builder: DOCKERFILE`), which already runs
  `pnpm --filter @book/types build` then `pnpm prisma:generate && pnpm build`
  inside the image (see the Dockerfile's builder stage).
- **Start command**: none to set — the Dockerfile's `CMD ["node", "dist/main"]`
  is what Railway runs; `PORT` is injected by Railway and the app already
  binds `0.0.0.0:$PORT` (`apps/api/src/main.ts`).
- **Migration command (release/pre-deploy step)**:

  ```bash
  pnpm --filter @book/api prisma:migrate:deploy
  ```

  Railway does not run this automatically. Run it either as Railway's
  dashboard-configurable **Pre-Deploy Command** (Service → Settings →
  Deploy), if enabled on your Railway plan, pointed at the same command; or
  manually from a machine/CI job with network access to the Railway Postgres
  instance's public/proxy connection string, **before** promoting a new
  deploy to receive traffic. Same ordering constraint as
  [§5 Migration and release order](#5-migration-and-release-order) above:
  never run this inside the container's `CMD`.

- **Health check path**: `/api/health` (already wired into `railway.json`'s
  `deploy.healthcheckPath` above, and into the Dockerfile's own
  `HEALTHCHECK` instruction — Railway uses its own HTTP check against this
  path to decide when a deploy is healthy).
- **Node/pnpm versions**: pinned by the Dockerfile, not by Railway's
  Nixpacks builder — `node:20-alpine` base image, `corepack prepare
pnpm@9.4.0`. No separate Railway Node/pnpm version setting is needed since
  `builder: DOCKERFILE` bypasses Nixpacks entirely.
- **Managed Postgres / Redis**: add Railway's Postgres and Redis plugins to
  the same project; use the connection strings they provide for
  `DATABASE_URL` / `REDIS_URL` (Railway's internal/private network URL if the
  API service is in the same project, to avoid egress and public-proxy
  latency).
- **Local Docker/`docker-compose` are unaffected** — `railway.json` is only
  read by Railway; it doesn't change `docker build`, `docker-compose up`, or
  any local script.

### 10.1a Railway (Generation worker)

A **second** Railway service in the same project, built from the same
`apps/api/Dockerfile` (same Root Directory, same `railway.json` build
config) but with its **Start Command overridden** to `node dist/worker`
(Service → Settings → Deploy → Custom Start Command) instead of the
Dockerfile's default `CMD`.

- **No `healthcheckPath`** — the worker has no HTTP server, so leave
  Railway's health check unset for this service (or, if the platform
  requires one, remove it rather than pointing it at a path that doesn't
  exist). Verify liveness via logs instead — see [Step
  7a](#4a-deploy-the-generation-worker)'s log-line check.
- **Environment variables**: the worker subset of [§10.3
  below](#103-environment-variables-by-service) — notably `DATABASE_URL`,
  `REDIS_URL`, `PDF_STORAGE_*`/`IMAGE_STORAGE_*` (**must match the API
  service's values exactly**), and `STORY_GENERATION_PROVIDER`/
  `IMAGE_GENERATION_PROVIDER`/`OPENAI_API_KEY` if using real
  generation. Do **not** set `AUTH_MODE`, `JWT_*`, `ALLOWED_ORIGINS`,
  `EMAIL_*`, or `STRIPE_*` on this service — see [§3.2 Environment ownership
  matrix](#env-ownership-matrix).
- **Deploy order**: promote the worker service's deploy only after the API
  service's migration step has succeeded and the API is healthy — same
  constraint as [Step 7a](#4a-deploy-the-generation-worker), just phrased
  for Railway's per-service deploy triggers instead of raw `docker run`.
- **Managed Redis/Postgres**: reuse the same Railway plugins the API service
  uses (same project) — do not provision separate instances.

### 10.2 Vercel (Web)

`apps/web/vercel.json` (config-as-code, picked up automatically once the
Vercel project's Root Directory is set to `apps/web`):

```json
{
  "framework": "nextjs",
  "installCommand": "cd ../.. && pnpm install --frozen-lockfile",
  "buildCommand": "cd ../.. && pnpm turbo run build --filter=@book/web"
}
```

- **Root Directory** (Vercel project setting): `apps/web`.
- **Framework preset**: Next.js (`framework: "nextjs"` in `vercel.json`) —
  Vercel auto-detects the `.next` output, no `outputDirectory` override
  needed.
- **Install/build commands**: both `cd ../..` back to the monorepo root
  first, because `@book/web` depends on the `@book/types` workspace package
  (resolves to `packages/types/dist`, per its `package.json` `main`/`types`
  fields) — running `pnpm install` and `pnpm turbo run build
--filter=@book/web` from the repo root lets Turborepo's `^build`
  dependency graph (`turbo.json`) build `@book/types` before `@book/web`,
  the same ordering the Dockerfile enforces manually for the API. This is
  Vercel's documented pattern for a Turborepo + pnpm workspace, not
  something specific to this repo.
- **Start command**: none — Vercel serves the build output itself, same as
  documented in [§4 Step 9](#step-9--builddeploy-web) above.

### 10.3 Environment variables by service

Exact names from `apps/api/src/config/env.schema.ts` and the two
`.env.example` files — same variables as the
[§3 Environment variable matrix](#3-environment-variable-matrix) above,
grouped here by which platform's dashboard they get set in.

**Railway (API) environment:**

| Variable                                                                                                                             | Example value                      | Notes                                                                                                                           |
| ------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                                                                                                                       | _(from Railway Postgres plugin)_   |                                                                                                                                 |
| `REDIS_URL`                                                                                                                          | _(from Railway Redis plugin)_      |                                                                                                                                 |
| `AUTH_MODE`                                                                                                                          | `jwt`                              | Must match `NEXT_PUBLIC_AUTH_MODE` on Vercel.                                                                                   |
| `JWT_SECRET`                                                                                                                         | `openssl rand -hex 32` output      |                                                                                                                                 |
| `JWT_REFRESH_SECRET`                                                                                                                 | `openssl rand -hex 32` output      |                                                                                                                                 |
| `WEB_APP_URL`                                                                                                                        | `https://your-app.vercel.app`      | Used to build links in verification/reset email.                                                                                |
| `ALLOWED_ORIGINS`                                                                                                                    | `https://your-app.vercel.app`      | CORS allowlist; comma-separate if adding a Vercel preview URL too.                                                              |
| `EMAIL_PROVIDER`                                                                                                                     | `resend`                           |                                                                                                                                 |
| `RESEND_API_KEY`                                                                                                                     | `re_...`                           | Required once `EMAIL_PROVIDER=resend`.                                                                                          |
| `EMAIL_FROM`                                                                                                                         | `StoryMe <noreply@yourdomain.com>` | Must be a verified sender/domain in Resend.                                                                                     |
| `EMAIL_REPLY_TO`                                                                                                                     | `support@yourdomain.com`           | Optional.                                                                                                                       |
| `STORY_GENERATION_PROVIDER`                                                                                                          | `mock` (or `openai`)               | `mock` keeps the demo free/deterministic.                                                                                       |
| `IMAGE_GENERATION_PROVIDER`                                                                                                          | `mock` (or `openai`)               | Same.                                                                                                                           |
| `OPENAI_API_KEY`                                                                                                                     | `sk-...`                           | Only if either provider above is `openai`.                                                                                      |
| `PDF_STORAGE_DRIVER`                                                                                                                 | `r2` (or `s3`, or leave `local`)   | `local` is ephemeral on Railway's container filesystem — see [Storage decision note](deployment-readiness.md#storage-decision). |
| `IMAGE_STORAGE_DRIVER`                                                                                                               | `r2` (or `s3`, or leave `local`)   | Same.                                                                                                                           |
| `PDF_STORAGE_BUCKET` / `PDF_STORAGE_REGION` / `PDF_STORAGE_ENDPOINT` / `PDF_STORAGE_ACCESS_KEY_ID` / `PDF_STORAGE_SECRET_ACCESS_KEY` | _(bucket credentials)_             | Only if `PDF_STORAGE_DRIVER`/`IMAGE_STORAGE_DRIVER` is `r2`/`s3`; shared by both.                                               |
| `PORT`                                                                                                                               | _(leave unset)_                    | Railway injects this; the app already reads it.                                                                                 |

**Vercel (Web) environment:**

| Variable                | Example value                         | Notes                                                                                         |
| ----------------------- | ------------------------------------- | --------------------------------------------------------------------------------------------- |
| `NEXT_PUBLIC_API_URL`   | `https://your-api.up.railway.app/api` | Include the `/api` suffix. Baked in at build time — set before the first Vercel build/deploy. |
| `NEXT_PUBLIC_AUTH_MODE` | `jwt`                                 | Must match `AUTH_MODE` on Railway.                                                            |

### 10.4 CORS / cookie / HTTPS notes

- **Both origins must be HTTPS.** Vercel and Railway both provision HTTPS by
  default — don't disable it or terminate TLS anywhere upstream of either
  platform's own edge.
- **`WEB_APP_URL` (Railway) must match the Vercel deployment's exact
  origin** — it's used to build the verification/reset links sent in email;
  a mismatch sends users to the wrong host.
- **`ALLOWED_ORIGINS` (Railway) must include the Vercel frontend's exact
  origin** — CORS is `credentials: true` (`apps/api/src/main.ts`), so this
  must be the specific origin(s), never `*`. Comma-separate if you also need
  to allow a Vercel preview-deployment URL.
- **Cookie behavior in production**: the refresh cookie is
  `Secure; SameSite=None` only when `NODE_ENV=production`
  (`apps/api/src/auth/refresh-cookie.ts`) — this is required for a
  cross-origin cookie (Railway API origin ≠ Vercel web origin) to be sent by
  the browser at all. Set `NODE_ENV=production` on the Railway service.
- **`trust proxy` is already set** (`app.set('trust proxy', 1)` in
  `apps/api/src/main.ts`, added in [Phase 6I](deployment-readiness.md#phase-6i))
  — Railway puts exactly one reverse-proxy hop in front of the container,
  so this is already correct for `req.ip`-based rate limiting without
  further changes.

### 10.5 Post-deploy smoke test (Vercel + Railway)

Same checks as the full [§6 Smoke test checklist](#6-smoke-test-checklist)
above, restated as a quick pass for this platform pair. Use a throwaway
email address you control.

- [ ] Open the Vercel frontend URL — landing page loads with no console errors.
- [ ] `curl https://<your-api>.up.railway.app/api/health` → `200`,
      `"status":"ok"`, `db`/`redis` both `up`.
- [ ] Register a new account at `/register` → redirected into `/dashboard`
      signed in (unverified).
- [ ] Receive the real verification email via Resend (check the inbox of the
      address you registered).
- [ ] Open the verification link → account marked verified.
- [ ] Log out, then log back in at `/login` with the same credentials →
      succeeds (would have failed with `401 EMAIL_NOT_VERIFIED` before
      verifying).
- [ ] Create a book via the 3-step wizard → redirected to the book detail
      page with status `created`.
- [ ] Click **Generate Story** → polls through pipeline stages to `complete`.
- [ ] Open the PDF preview (`GET /api/books/:id/pdf/preview`) and download it.
- [ ] Log out.
- [ ] On `/login`, click **Forgot password?**, submit the same email, and
      receive the real reset email via Resend.
- [ ] Open the reset link, set a new password → succeeds.
- [ ] Log in with the **new** password → succeeds.
- [ ] Attempt to log in with the **old** password → rejected.
- [ ] Tail Railway's service logs while repeating login/verification above →
      confirm no raw JWT, refresh token, verification token, or reset token
      value appears anywhere in the log output (see
      [§9 Security notes](#security-notes) above).

## Remaining blockers before public production

1. ~~A real transactional email provider for the real auth endpoints~~
   **Resolved in Phase 6H** — `ResendEmailService` is available behind
   `EMAIL_PROVIDER=resend` (see the [environment variable
   matrix](#3-environment-variable-matrix) above). Real credential
   verification (`AUTH_MODE=jwt`, Phase 6B/6C), auth rate limiting (Phase
   6E), email verification (Phase 6F,
   `POST /api/auth/{verify-email,resend-verification}`), password reset
   (Phase 6G, `POST /api/auth/{request-password-reset,reset-password}`), and
   now real email delivery (Phase 6H) are all done — see
   [docs/auth-architecture.md §16](auth-architecture.md#16-phase-6h--real-transactional-email-provider).
   This deployment must still explicitly set `EMAIL_PROVIDER=resend` plus
   `RESEND_API_KEY`/`EMAIL_FROM` — it defaults to `ConsoleEmailService`
   (console-only) otherwise.
2. **Wire the migration step into an actual deploy pipeline** (platform
   release-phase hook or CI job), rather than running it by hand per this
   runbook.
3. ~~Move generation to a real queue+worker before scaling to multiple API
   instances — BullMQ/Redis are provisioned but not wired to any processor
   yet.~~ **Resolved in Phase 3K** — `GenerationQueueProcessor` consumes
   `QUEUES.BOOK_GENERATION` durably, and the worker runs as its own
   entrypoint (`apps/api/src/worker.ts`) separate from the API — see [Step
   7a](#4a-deploy-the-generation-worker) above and [Known blockers
   item 5](deployment-readiness.md#known-blockers) in the underlying audit.
   BullMQ already distributes jobs safely across multiple API/worker
   instances; what still favors care before autoscaling either tier is the
   default `local` storage drivers (not shared across instances — set
   `PDF_STORAGE_DRIVER`/`IMAGE_STORAGE_DRIVER` to `r2`/`s3`, already required
   by this runbook) and `GenerationRunRecoveryService`'s startup sweep
   running redundantly on every instance's boot (safe, but wasted work).
