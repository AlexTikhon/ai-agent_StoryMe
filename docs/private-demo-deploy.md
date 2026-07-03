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
  — no rate limiting on auth endpoints, no email verification, no
  password-reset flow. Do not treat this runbook as a public-launch
  checklist; see [deployment-readiness.md](deployment-readiness.md) for
  what's still outstanding beyond auth.

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
- **Generation**: current in-process runner (`GenerationTaskRunner`) — no
  separate worker process, no queue infrastructure to stand up.
- **Auth**: `JwtAuthGuard` (email/password + JWT + rotating refresh cookie),
  `AUTH_MODE=jwt` by default — see the warning above.
- **Redis**: see [Is Redis required?](#is-redis-required) below — short
  answer: **yes, to boot**, but not for its intended purpose yet.

## 2. Recommended provider path

| Piece | Recommendation | Why |
|---|---|---|
| Web | **Vercel** | Zero-config Next.js hosting, matches Phase 5D's audited path exactly (no Dockerfile needed). |
| API | **Render, Fly.io, or Railway** (Docker service) | All three run an arbitrary Dockerfile as a single always-on instance, which is what the current in-process generation runner needs (see [Known limitations](#known-limitations) — horizontal scaling is not yet safe). Pick whichever the team already has an account on; nothing below is provider-specific beyond "runs a Docker image and lets you set env vars." |
| Database | **Neon or Supabase** (managed Postgres), or the API host's own managed Postgres add-on if using Render/Railway | Either works; schema/migrations are plain Postgres, no provider-specific features used. |
| Storage | **Cloudflare R2** | Already the primary implementation target (`PDF_STORAGE_DRIVER=r2` / `IMAGE_STORAGE_DRIVER=r2`), S3-compatible, no egress fees. AWS S3 works identically via `PDF_STORAGE_DRIVER=s3`. |
| Redis | **A small managed Redis** (Upstash, Redis Cloud, or the API host's own Redis add-on) | Required for the app to boot and pass `/api/health` — see below. A free/smallest tier is enough; nothing performance-sensitive runs through it today. |

This is the same architecture already recommended in
[deployment-readiness.md's Recommended deployment architecture](deployment-readiness.md#recommended-deployment-architecture);
this runbook just turns it into an ordered list of commands.

### Is Redis required? {#is-redis-required}

**Yes, right now, but only to satisfy the app's boot-time checks — not for
its intended purpose (queue-backed generation).**

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
- **BullMQ queues are registered (`apps/api/src/queue/queue.module.ts`,
  `QueueModule`) but nothing enqueues or processes jobs through them today.**
  There is no `@InjectQueue`/`Processor` anywhere in the codebase that
  consumes those queues. Generation runs fully in-process via
  `GenerationTaskRunner`, not through Redis/BullMQ. Redis is provisioned
  infrastructure for a queue that doesn't exist yet, not a runtime
  dependency of the generation pipeline itself.

Practically: provision the smallest/free tier of a managed Redis add-on and
set `REDIS_URL` — don't try to remove the dependency to save a step, since
doing so would require an env-schema and health-check code change (out of
scope for this docs-only phase).

## 3. Environment variable matrix

"Required for private demo?" assumes mock generation (no OpenAI spend) and
cloud storage (not local filesystem, since most container hosts have an
ephemeral filesystem — see
[Known blockers #1](deployment-readiness.md#known-blockers)).

| Variable | App | Required for private demo? | Example value shape | Notes |
|---|---|---|---|---|
| `DATABASE_URL` | API | **Yes** | `postgresql://user:pass@host:5432/db` | Managed Postgres connection string. |
| `REDIS_URL` | API | **Yes** | `redis://:password@host:6379` | See [Is Redis required?](#is-redis-required) — needed to boot and pass health checks, not for queue processing yet. |
| `JWT_SECRET` | API | **Yes** | 32+ char random hex, `openssl rand -hex 32` | Signs/verifies access tokens (`JwtAuthGuard`, `TokenService`). |
| `JWT_REFRESH_SECRET` | API | **Yes** | 32+ char random hex, `openssl rand -hex 32` | HMAC key used to hash refresh tokens before they're stored in `RefreshToken.tokenHash`. |
| `AUTH_MODE` | API | No (defaults to `jwt`, recommended for this runbook) | `dev` \| `jwt` | Must match the web app's `NEXT_PUBLIC_AUTH_MODE` exactly — a mismatch 401s every request. Only set to `dev` for a trusted-operator-only deployment (see the warning above). |
| `PORT` | API | No (has default `4000`) | `4000` | Most hosts (Render/Fly/Railway) set this automatically; the API already reads and binds it on `0.0.0.0`. |
| `ALLOWED_ORIGINS` | API | **Yes** | `https://storyme-demo.vercel.app` | CORS allowlist, comma-separated for multiple origins (e.g. preview + production Vercel URLs). Must match the web app's deployed origin exactly. |
| `OPENAI_API_KEY` | API | Only if using real generation | `sk-...` | Required only when `STORY_GENERATION_PROVIDER=openai` or `IMAGE_GENERATION_PROVIDER_TOKEN=openai`. Leave the providers on `mock` (default) for a free/deterministic demo. |
| `STORY_GENERATION_PROVIDER` | API | No (defaults to `mock`) | `mock` \| `openai` | Set to `openai` only if you want real story text and have budget. |
| `IMAGE_GENERATION_PROVIDER_TOKEN` | API | No (defaults to `mock`) | `mock` \| `openai` | Same — real image generation costs money per call (see `REAL_GENERATION_MAX_PAGES` guardrail). |
| `PDF_STORAGE_DRIVER` | API | **Yes, set to `r2` or `s3`** | `r2` | Do not leave as default `local` — the container filesystem is ephemeral on every host in this runbook, so previously generated PDFs disappear on redeploy/restart. |
| `IMAGE_STORAGE_DRIVER` | API | **Yes, set to `r2` or `s3`** | `r2` | Same reasoning as `PDF_STORAGE_DRIVER`, same ephemeral-filesystem risk for generated images. |
| `PDF_STORAGE_BUCKET` | API | **Yes** (if using cloud storage) | `storyme-demo-previews` | Shared by both PDF and image storage (images go under an `images/` key prefix in the same bucket). |
| `PDF_STORAGE_REGION` | API | **Yes** (if using cloud storage) | `auto` (R2) or `us-east-1` (S3) | R2 always uses `auto`. |
| `PDF_STORAGE_ENDPOINT` | API | **Yes for R2**, omit for AWS S3 | `https://<account-id>.r2.cloudflarestorage.com` | Only needed for R2 (or any non-AWS S3-compatible endpoint). |
| `PDF_STORAGE_ACCESS_KEY_ID` | API | **Yes** (if using cloud storage) | `<r2-or-iam-access-key>` | Scope the credential to only this bucket if the provider supports it. |
| `PDF_STORAGE_SECRET_ACCESS_KEY` | API | **Yes** (if using cloud storage) | `<r2-or-iam-secret>` | Treat as a secret — set via the host's secret manager, not committed anywhere. |
| `PDF_STORAGE_PUBLIC_BASE_URL` | API | No | *(not currently read by any code path)* | Not present in `apps/api/src/config/env.schema.ts` or `pdf-storage.ts` today — PDFs are served through the API's own preview endpoint (`GET /api/books/:id/pdf/preview`), not a direct public bucket URL. Included here for completeness since the task template asked for it; there is nothing to set. |
| `NEXT_PUBLIC_API_URL` | Web | **Yes** | `https://storyme-api-demo.onrender.com/api` | Baked in at **build time** (Next.js inlines `NEXT_PUBLIC_*` at build), not read at request time — must be set in Vercel's project env vars *before* the first build, and changing it requires a rebuild. Include the `/api` suffix. |
| `NEXT_PUBLIC_AUTH_MODE` | Web | No (defaults to `jwt`, recommended for this runbook) | `dev` \| `jwt` | Same build-time-inlined caveat as `NEXT_PUBLIC_API_URL`. Must match the API's `AUTH_MODE` exactly. |

Vars not covered above (`STRIPE_*`, `GOOGLE_*`, `ANTHROPIC_API_KEY`,
`FAL_API_KEY`, `R2_ACCOUNT_ID`/`R2_*`) are optional and reserved for features
not built yet — see `.env.example` for the full annotated list. They can be
left unset.

## 4. Setup order

Run these in order — each step depends on state from the one before it.

### Step 1 — Provision Postgres

Create the managed Postgres instance (Neon/Supabase/host add-on). Note the
connection string for `DATABASE_URL`.

### Step 2 — Provision Redis

Create the smallest managed Redis instance (Upstash/Redis Cloud/host
add-on). Note the connection string for `REDIS_URL`. See
[Is Redis required?](#is-redis-required) if this step feels skippable — it
isn't, yet.

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

If this doesn't return `200`/`"status":"ok"`, do not proceed to step 8 —
fix DB/Redis connectivity first (check `db`/`redis` sub-status in the
response body to tell which one is failing).

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
8. configure web env vars
9. build/deploy web
10. run smoke test
```

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
start/restart the API container after it succeeds.

## 6. Smoke test checklist

Run this after step 10, and again after any redeploy:

- [ ] Open the web app's landing page (`/`) — loads without console errors.
- [ ] Navigate to `/dashboard`.
- [ ] Click **Create Your First Book**, fill in the 3-step wizard, submit.
- [ ] Confirm redirect to the new book's detail page with status `created`.
- [ ] Click **Generate Story**; confirm the page polls and progresses through
      pipeline stages (`char_build` → … → `complete`).
- [ ] Confirm the generated story preview (story plan, page plan, draft
      text, images) renders on the detail page.
- [ ] If generation fails, click **Retry generation** and confirm it
      recovers.
- [ ] Once `complete`, click **Open PDF** — confirm it opens
      `GET /api/books/:id/pdf/preview` in a new tab and renders.
- [ ] Click **Download PDF** — confirm a file downloads.
- [ ] **Cloud storage durability check**: restart the API container
      (`docker restart storyme-api-demo`, or trigger a redeploy on the
      platform), then reload the book detail page and re-open/re-download
      the PDF — confirm it still works. This is the check that actually
      proves `PDF_STORAGE_DRIVER=r2`/`IMAGE_STORAGE_DRIVER=r2` is wired
      correctly; with the default `local` driver this step would fail.

## 7. Rollback notes

- **API**: redeploy the previous Docker image tag on the platform (Render/
  Fly/Railway all keep prior deploys/images available for rollback). No
  database changes are needed for a code-only rollback.
- **Database**: `prisma migrate deploy` only applies forward migrations —
  there is no automated rollback command. If a bad migration reaches
  production, write and apply a new forward migration that undoes the
  change; do not attempt to run an old migration backwards or hand-edit
  `_prisma_migrations`.
- **Web**: Vercel keeps prior deployments and supports instant rollback to
  any previous build via its dashboard/CLI — use that rather than
  re-running a build with an older commit.
- **Storage**: PDFs/images are additive (new generations write new keys);
  rolling back the API doesn't delete or corrupt previously stored files.

## 8. Known limitations

Carried over from the underlying audit
([deployment-readiness.md — Known blockers](deployment-readiness.md#known-blockers)),
restated for this private-demo scope:

- **`AUTH_MODE=dev`/`DevAuthGuard` is not production-safe for public
  exposure** — real auth (`AUTH_MODE=jwt`, this runbook's default) closes
  that gap; dev mode remains only as a documented local/trusted-operator
  fallback (see the warning at the top of this doc). No rate limiting on
  auth endpoints, no email verification, and no password-reset flow exist
  yet even under `jwt` mode — still a private-demo-scoped limitation.
- **In-process generation, no worker process.** `GenerationTaskRunner` runs
  the generation pipeline in the same process as the HTTP server. This is
  fine for a single always-on instance (what this runbook provisions) but
  is not safe to scale horizontally — a second instance would run its own
  independent recovery/polling with no shared coordination beyond the
  database. Don't configure autoscaling/multiple replicas for the API on
  whichever host you pick.
- **Redis is a boot-time/health-check dependency today, not a queue backend
  in use** — see [Is Redis required?](#is-redis-required). Don't skip
  provisioning it, but also don't expect it to be doing meaningful work.
- **No payments/credits enforcement** — `User.credits` and Stripe fields
  exist in the schema but nothing charges credits or calls Stripe. Not
  relevant to a private demo, but don't advertise it as a real limit.
- **No cancellation or partial-completion flow** — `BookStatus.Cancelled`
  and `BookStatus.Partial` are reserved schema states with no code path
  that produces them yet.
- **Migrations are a manual/CI step, not wired into any specific deploy
  pipeline yet** — this runbook documents the command and where it fits in
  the order, but doesn't wire it into a specific platform's release-phase
  hook (Render's "pre-deploy command," Fly's `release_command`, etc.) since
  that's platform-specific and out of scope for this docs-only phase.

## Remaining blockers before public production

1. **Rate limiting, email verification, and password reset for the real
   auth endpoints** (`/api/auth/*`) — real credential verification exists
   (`AUTH_MODE=jwt`, Phase 6B/6C), but brute-force/enumeration protection
   and account-recovery flows don't yet.
2. **Wire the migration step into an actual deploy pipeline** (platform
   release-phase hook or CI job), rather than running it by hand per this
   runbook.
3. **Move generation to a real queue+worker** before scaling to multiple
   API instances — BullMQ/Redis are provisioned but not wired to any
   processor yet.
