# Deployment Readiness — Phase 5A/5B/5C/5D Audit

Audit of the current MVP's readiness to deploy outside a local dev machine.
Phase 5A was an audit + minimal-cleanup pass; Phase 5B closed the one real
code gap it found by adding `CloudImageAssetStorage`; Phase 5C actually built
and ran the Docker image end-to-end for the first time (previous phases had
only inspected the Dockerfile statically) and fixed what that uncovered;
Phase 5D audited the web app's deployment path (build/runtime assumptions,
env handling, CORS alignment) and made the hosting decision that Phase 5C
left open. Nothing here has been deployed to a real host, and no cloud
provider, payments, or real auth were added.

## Current deployability status

**The API's Docker image now builds and boots successfully, verified
end-to-end** (see [Phase 5C: Docker build verification](#phase-5c-docker)) —
this had never actually been built before Phase 5C, and doing so surfaced
three real bugs (two Docker-specific, one an application bug affecting every
run mode) that are now fixed.

**The web app's deployment path is now decided and documented** (see
[Phase 5D: Web deployment readiness](#phase-5d-web) below) — Vercel (or any
Node host running `next build` / `next start`), no Dockerfile needed. The
audit found the app's build/runtime assumptions already correct; no code
changes were required.

**Durable storage is available end-to-end for a single-instance production
deploy.** Both generated PDFs and generated images default to the API
container's local filesystem, which most hosts (containers, PaaS,
serverless) do not persist across restarts, redeploys, or multiple instances
— but both now have a working cloud-backed alternative (`PDF_STORAGE_DRIVER`
/ `IMAGE_STORAGE_DRIVER` set to `s3` or `r2`), so this is now a config choice
rather than a missing feature.

Everything else — env validation, CORS, health checks, migrations, build/start
scripts — is already deploy-ready or only needs configuration, not code
changes.

## Phase 6I: final production readiness audit {#phase-6i}

A full pass over env config, the auth flows end-to-end, security-sensitive
behavior, and these deployment docs, after Phase 6D–6H closed out the
real-auth/rate-limiting/verification/reset/email work. Scope was audit +
small concrete fixes only — no new features, no OAuth, no refactors.

**One real bug found and fixed**: `apps/api/src/main.ts` never configured
Express's `trust proxy` setting. Every recommended deploy target in this doc
(Render/Fly/Railway behind their edge, or Vercel) puts exactly one reverse
proxy in front of the API, so `req.ip` — the key `AuthRateLimitGuard` uses to
bucket rate-limit attempts by client — resolved to the *proxy's* address on
every request, not the real client's. For `login`/`register` this was masked
by the request's `email` also being part of the key, but `refresh`/`logout`
have no email to key on, so this collapsed to **one shared rate-limit bucket
for every client in production**, i.e. a handful of concurrent legitimate
users could 429-lock everyone out of session refresh. Fixed with
`app.set('trust proxy', 1)` (trusts exactly the one reverse-proxy hop these
deploys use). No test previously existed that exercised `req.ip` in a real
HTTP context (no e2e/supertest harness in this repo — see
[§12.4](auth-architecture.md#124-manual-verification-checklist)), so this
had no automated coverage to catch it; `AuthRateLimitGuard`'s existing unit
tests construct `request.ip` directly and were unaffected by this fix.

Everything else audited (env var documentation, register/login/logout/
refresh/getMe/verify/resend/forgot-password/reset-password flows, token
hashing, no-enumeration responses, cookie/CORS config, error-response
shape) matched what's already documented below and in
[`docs/auth-architecture.md`](auth-architecture.md) — no other code changes
were needed. See [Production readiness summary](#production-readiness-summary)
below for the current three-tier blocker/recommendation/enhancement
breakdown.

## Production readiness summary {#production-readiness-summary}

### MVP blockers (must fix before any deploy)

None remaining. Real auth, rate limiting (now IP-correct behind a proxy —
see [Phase 6I](#phase-6i) above), email verification, password reset, and a
real transactional email provider are all done end-to-end.

### Production recommendations (should do before real/public traffic)

- **Set `PDF_STORAGE_DRIVER` / `IMAGE_STORAGE_DRIVER` to `s3` or `r2`** —
  the default `local` driver writes to the container's filesystem, which is
  ephemeral (and, in the recommended two-service topology, not shared
  between the api and worker containers at all) on every host recommended
  here. **For `PDF_STORAGE_DRIVER` specifically, the standalone worker
  process now refuses to boot in production with `local`** — see
  [PDF storage: separate worker guard](#pdf-storage-worker-guard) below. See
  [Storage decision note](#storage-decision).
- **Explicitly set `EMAIL_PROVIDER=resend` plus `RESEND_API_KEY` and
  `EMAIL_FROM`** for a deployment that needs real users to receive
  verification/reset email — the default (`console`/unset) only logs the
  link server-side, which is fine for a private/trusted demo but not for
  real signups. Boot fails fast if `resend` is set without both required
  vars (`env.schema.ts`).
- **Wire `prisma migrate deploy` into an actual release pipeline** (CI job
  or platform release-phase hook) instead of running it by hand per this
  doc's [Migration command](#migration-command).
- ~~Move generation to a real queue + worker~~ **Done (Phase 3K)** — see
  [Known blockers](#known-blockers) item 5.
- **Consider a Redis-backed rate limiter** before running more than one API
  instance — `RateLimiterService` is in-memory/per-process today, correct
  only for a single-instance deploy (see
  [§13.2](auth-architecture.md#132-why-in-memory-not-redis)).
- ~~Embed real fonts before shipping `ru`/`pl` output~~ **Done** — see
  [Known blockers](#known-blockers) item 6.

### Future enhancements (not required for MVP)

- **OAuth** (Google/Apple) — schema already reserves `oauthProvider`/
  `oauthId`; documented as a follow-up auth method, not a blocker for the
  current email/password + JWT flow.
- **Payments/credits enforcement** — `User.credits` and Stripe fields exist
  in the schema but nothing charges credits or calls Stripe yet.
- **Cancellation / partial-completion flow** — `BookStatus.Cancelled` and
  `BookStatus.Partial` are reserved schema states with no code path that
  produces them yet.

## Phase 5C: Docker build verification {#phase-5c-docker}

Previous phases only read the Dockerfile; nobody had actually run
`docker build` against it. Doing so in Phase 5C failed immediately, and
fixing that surfaced three separate, real bugs — the third breaks the app in
*every* run mode, not just Docker:

1. **`packages/types` was never built before `apps/api`'s `tsc` build ran.**
   `apps/api` imports `@book/types`, which resolves to
   `packages/types/dist/index.js` — but the Dockerfile only ever built
   `apps/api`, so `dist/` didn't exist yet and the build failed with
   `TS2307: Cannot find module '@book/types'`. Fixed by adding
   `RUN pnpm --filter @book/types build` before the `apps/api` build step.
2. **pnpm's symlinked `node_modules` doesn't survive being relocated.**
   pnpm (unlike npm) doesn't hoist dependencies into a flat `node_modules` —
   every package under `apps/api/node_modules` is a *relative* symlink into
   a shared `node_modules/.pnpm` virtual store, and the `@book/types` entry
   is a relative symlink to `packages/types`. The runtime stage's original
   `COPY --from=builder .../apps/api/node_modules ./node_modules` collapsed
   that into a shallower directory, so those relative symlink targets no
   longer resolved — breaking *every* dependency, including `@nestjs/core`
   itself (`Error: Cannot find module '@nestjs/core'` at container start).
   Fixed by having the runtime stage preserve the exact
   `/app/{node_modules,packages/types,apps/api}` directory layout the
   builder stage used, instead of flattening it.
3. **The Prisma query engine failed to load on Alpine
   (`Error loading shared library libssl.so.1.1`).** `node:20-alpine`
   ships OpenSSL 3.x with no `libssl.so.1.1` compat package available, and
   with no `openssl` binary present at all, `prisma generate` couldn't probe
   the actual version and silently defaulted to the wrong (1.1.x) engine
   target. Fixed by installing `openssl` in both the builder and runtime
   Alpine stages, and by pinning
   `binaryTargets = ["native", "linux-musl-openssl-3.0.x"]` explicitly in
   `apps/api/prisma/schema.prisma` so this doesn't depend on detection
   succeeding.
4. **`DevAuthGuard` failed to resolve its `UsersService` dependency at boot
   — in every run mode, not just Docker** (`apps/api/src/auth/auth.module.ts`).
   `BooksModule` only imports `AuthModule` (not `UsersModule` directly) and
   applies `@UseGuards(DevAuthGuard)` to `BooksController`. Nest resolves a
   cross-module guard's *own* constructor dependencies relative to what the
   *consuming* module (`BooksModule`) can see, not just the guard's
   declaring module (`AuthModule`) — so `AuthModule` exporting only
   `DevAuthGuard` (and not also `UsersModule`) left `UsersService`
   unreachable from `BooksModule`'s perspective, and the app crashed at
   startup with `Nest can't resolve dependencies of the DevAuthGuard`.
   Reproduced identically via `pnpm --filter @book/api dev`, via
   `node dist/main` outside Docker, and inside the container — this was a
   real, pre-existing bug independent of Docker; the app could not boot in
   *any* mode before this fix. Fixed by also exporting `UsersModule` from
   `AuthModule`.

All four were verified fixed by: a successful `docker build`, starting the
resulting container against real `docker-compose` Postgres/Redis, confirming
`GET /api/health` returns `200 {"status":"ok",...}`, and confirming Docker's
own `HEALTHCHECK` reports `healthy`. See
[Build/run commands](#build-run-commands) below for the exact commands used.

**Known tradeoff from fix #2**: preserving `node_modules` directory depth in
the runtime stage (rather than flattening it) means the full pnpm virtual
store — including devDependencies, since `pnpm install` in the deps stage
doesn't use `--prod` — ships in the runtime image (~770MB uncompressed vs. a
typical slim Node image). Trimming this would mean restructuring the install
step (e.g. `pnpm deploy` or a `--prod` reinstall pass) — left as a follow-up
since it's an optimization, not a correctness issue, and this phase is
scoped to build/boot correctness.

## Phase 5D: Web deployment readiness {#phase-5d-web}

Audited `apps/web`'s deployment path — build/runtime assumptions, env
handling, CORS/API-URL alignment — and made the hosting decision Phase 5C
left open (see [Known blockers](#known-blockers) item 3, now resolved below).
**No code changes were needed**: the app's env handling, CORS setup, and
build/start scripts were already deploy-ready.

### Recommended web hosting: Vercel (or any Node host running `next build` / `next start`)

`apps/web` is a standard Next.js 14 App Router app with no `output` mode set
in `next.config.mjs` (no static export, no standalone bundling). Confirmed by
running `pnpm --filter @book/web build`: `/dashboard/books/[id]` builds as a
dynamic (server-rendered on demand) route, while `/`, `/dashboard`, and
`/dashboard/books/new` are static — this mix is exactly what Vercel's default
Next.js runtime (or `next start` on any Node host) handles natively, and it
rules out static-export hosting (e.g. plain S3/Netlify-static) without
further work. A **Dockerfile was not added** — Vercel/managed Next hosting
was picked as the simpler path for an MVP demo, and the task only calls for
one when Docker is the recommended target.

- **Build command**: `pnpm --filter @book/web build` (`next build`).
- **Start command**: only needed for self-hosting on a plain Node host —
  `pnpm --filter @book/web start` (`next start`). Vercel builds and serves
  the app itself; there is no separate start step to configure there.
- **Output mode**: default (Node server), not static export — required
  because of the dynamic `[id]` route above.

### Environment variables

- **`NEXT_PUBLIC_API_URL`** (`apps/web/.env.example`) — the only env var the
  web app reads. Used in two places, both at module scope:
  `apps/web/src/lib/api/client.ts` (`apiFetch`/`apiFetchBlob` base URL) and
  `apps/web/src/lib/api/asset-url.ts` (`resolveAssetUrl`, used to turn
  API-relative paths into absolute URLs for the PDF preview link).
- **Baked in at build time, not read at request time.** Next.js inlines
  `NEXT_PUBLIC_*` vars via webpack at build time; there is no server-side
  runtime override. Practically: set `NEXT_PUBLIC_API_URL` in the Vercel
  project's environment variables (or CI, for self-hosted builds) *before*
  running the build — changing it requires a rebuild + redeploy, not just an
  env var edit on a running instance.
  - Defaults to `http://localhost:4000/api` when unset, which is only
    correct for local dev.
- `NEXT_PUBLIC_AUTH_MODE` (`dev` | `jwt`, defaults to `jwt`) — same
  build-time-inlined caveat as `NEXT_PUBLIC_API_URL`. Must match the API's
  `AUTH_MODE`. See [Dev-auth warning](#phase-5d-dev-auth) below.
- No server-only secret exists in `apps/web` — the access token lives only
  in an in-memory module (`apps/web/src/lib/auth/token-store.ts`), never
  `localStorage`/`sessionStorage`, and the refresh token never reaches JS at
  all (`HttpOnly` cookie).

### API client / cross-origin behavior

- In `jwt` mode (default), `apiFetch`/`apiFetchBlob` send `credentials:
  'include'` (so the `storyme_refresh` `HttpOnly` cookie round-trips
  cross-origin) plus `Authorization: Bearer <accessToken>` from the
  in-memory token store. A `401` triggers exactly one silent
  `POST /api/auth/refresh` + retry before surfacing the error (see
  `apps/web/src/lib/api/client.ts`).
- In `dev` mode, identity is still carried via the `x-user-email`/
  `x-user-name` headers (`DevAuthGuard`), unchanged from before.
- The API's CORS setup (`apps/api/src/main.ts`) already allows both:
  `ALLOWED_ORIGINS` is env-driven (not hardcoded), `credentials: true` is
  set, and `allowedHeaders` includes `Authorization` alongside
  `x-user-email`/`x-user-name`. **The only action needed at deploy time is
  setting `ALLOWED_ORIGINS` on the API to the web app's actual deployed
  origin** — no code change. `SameSite=None; Secure` on the refresh cookie
  (`refresh-cookie.ts`) requires HTTPS on both origins in production, which
  Vercel/Render/Fly/Railway provide by default.
- Confirmed no other hardcoded `localhost` URLs exist in request paths.

### Note: unused `next.config.mjs` image remote pattern

`apps/web/next.config.mjs` whitelists `http://localhost:9000` (the local
MinIO port from `docker-compose.yml`) under `images.remotePatterns`. Grepped
the app for `next/image`/`<Image` usage — there is none; generated image URLs
are currently only ever displayed as plain text
(`ImageEntryCard` in `apps/web/src/app/dashboard/books/[id]/page.tsx`), never
rendered via Next's `<Image>` component. This config is therefore inert today
and not a deployment blocker, but flagging it: if a future phase renders
generated images with `next/image`, this remote-pattern allowlist will need
the production image host (e.g. the R2/S3 bucket's public domain) added, or
image loading will silently fail in production.

### Dev-auth warning {#phase-5d-dev-auth}

As of Phase 6C, `apps/web` has real login/register (`/login`, `/register`,
`AuthProvider`, protected `/dashboard/*` routes) and defaults to
`NEXT_PUBLIC_AUTH_MODE=jwt`, matching the API's `AUTH_MODE=jwt` default —
per-user identity via password + JWT, no shared dev user. `dev` mode is
kept only as a documented **local/trusted-operator-only** fallback: setting
`NEXT_PUBLIC_AUTH_MODE=dev` sends a **hardcoded**
`x-user-email: dev@storyme.local` / `x-user-name: Dev User` pair on every
request (`apps/web/src/lib/api/client.ts`), skips the login screen
entirely, and requires the matching API to also run `AUTH_MODE=dev`. **Do
not deploy any publicly reachable environment with `AUTH_MODE=dev`** —
anyone who reaches the API and sets their own `x-user-email` header can
impersonate any user, dev-mode identity is not connected to any credential.

### Web deployment checklist

1. Set `NEXT_PUBLIC_API_URL` in the hosting platform's build-time env vars
   to the deployed API's public URL (including the `/api` suffix, e.g.
   `https://api.example.com/api`) — **before** the first build.
2. Set `NEXT_PUBLIC_AUTH_MODE` to match the API's `AUTH_MODE` (both default
   to `jwt` if left unset — a mismatch 401s every request).
3. Set `ALLOWED_ORIGINS` on the API to the deployed web app's origin
   (e.g. `https://storyme.example.com`) — comma-separated if there are
   multiple (e.g. preview + production Vercel URLs).
4. Run `pnpm --filter @book/web build` (Vercel does this automatically from
   the repo; a self-hosted Node host needs this plus `pnpm --filter @book/web
   start` after).
5. Verify the deployed web app can reach the deployed API: register/log in,
   create a book, confirm the detail page's polling and PDF open/download
   work cross-origin, and that `/dashboard` redirects to `/login` when
   signed out.

## PDF storage: separate worker guard {#pdf-storage-worker-guard}

Closes a real production incident: a book reached `status: 'complete'`
("Your PDF is ready" in the UI), but `GET /api/books/:id/pdf/preview`
returned `404 { "message": "PDF file not found in storage" }` on every
attempt. Root cause was exactly the risk [Known blockers](#known-blockers)
item 1 already flagged, but only as a recommendation, not an enforced
guard: the deployed **worker** service (which renders and saves the PDF)
and the **api** service (which serves it) run in separate containers with
separate filesystems, and neither had `PDF_STORAGE_DRIVER` set — so both
silently defaulted to `local`. The worker wrote `storybook.pdf` to *its own*
container's `tmp/` directory; the API's container never had that file, so
every preview/download request 404'd, even though generation itself
reported success.

`CloudPdfStorage` (s3/r2) already existed and needed no code changes — the
gap was purely that nothing stopped a production deploy from running the
separate-worker topology with the unsafe `local` driver. Two changes close
it:

- **`apps/api/src/pdf/pdf-storage.ts`** exports
  `assertPdfStorageSupportsWorker(env)`: throws a clear, actionable error
  (naming every required `PDF_STORAGE_*` var) when `NODE_ENV=production` and
  `PDF_STORAGE_DRIVER` is `local` (the default when unset).
  `apps/api/src/worker.ts` calls it as the very first thing in `bootstrap()`
  — before any DB/Redis connection is opened — so a misconfigured worker
  service crash-loops immediately with a readable error in its boot logs
  instead of silently generating PDFs no API instance can ever serve. The
  **api** entrypoint (`main.ts`) is intentionally not guarded the same way:
  the local single-process dev convenience
  (`ENABLE_GENERATION_WORKER=true` with `pnpm --filter @book/api dev`) is a
  genuinely safe same-container case and must keep working unguarded.
- **`GET /:id/generation-diagnostics`** now returns a `pdfStorage` field
  (`{ driver, keyPresent, previewAvailable }`) so this failure mode is
  visible per-book without needing container/log access — see "PDF storage
  diagnostics (`pdfStorage`)" in
  [`apps/api/docs/local-generation-pipeline.md`](../apps/api/docs/local-generation-pipeline.md).
  `keyPresent: true, previewAvailable: false` is the specific signature of
  this bug: the book claims a PDF was saved, but this process's configured
  storage can't produce it.

See "Troubleshooting: PDF ready but preview/download 404s" below for the
step-by-step diagnosis procedure this incident led to.

## Known blockers

1. **Local filesystem storage is the default and is not durable in most
   production hosts.** `LocalPdfStorage` and `LocalImageAssetStorage`
   (`apps/api/src/pdf/pdf-storage.ts`, `apps/api/src/images/image-asset-storage.ts`)
   write to `apps/api/tmp/`. On a host with an ephemeral or non-shared
   filesystem (most container platforms, autoscaled instances, redeploys),
   previously generated PDFs and images disappear. This is now a **config
   gap, not a code gap**: `CloudPdfStorage` and `CloudImageAssetStorage`
   (s3/r2) both exist (see below) — a production deploy just needs
   `PDF_STORAGE_DRIVER` / `IMAGE_STORAGE_DRIVER` set to `s3` or `r2` plus
   credentials. **For `PDF_STORAGE_DRIVER`, the standalone worker process
   now refuses to boot in production with `local`** — see
   [PDF storage: separate worker guard](#pdf-storage-worker-guard) above.
   `IMAGE_STORAGE_DRIVER` has no equivalent boot guard yet — a production
   deploy that forgets to set it will silently degrade generated images to
   placeholder rectangles at PDF-render time rather than 404ing (see
   "Images" in `apps/api/docs/pdf-rendering.md`), which is a real but
   separate follow-up, not covered by this phase.
2. **No `prisma migrate deploy` step in the container.** `apps/api/Dockerfile`
   builds and runs `node dist/main` only — it does not apply migrations.
   Migrations must be run as a separate deploy step (`pnpm --filter @book/api
   prisma:migrate:deploy`) before the new container starts serving traffic.
3. ~~No web app Dockerfile / hosting decision.~~ **Resolved in Phase 5D**:
   Vercel (or any Node host via `next build` / `next start`) is the
   recommended path — see
   [Phase 5D: Web deployment readiness](#phase-5d-web) above. No Dockerfile
   was added since it isn't the recommended path for this MVP.
4. ~~Dev-only auth.~~ **Resolved in Phase 6B/6C**: real email/password auth
   (JWT access token + rotating refresh cookie) exists end-to-end, backend
   and frontend, and is the default (`AUTH_MODE`/`NEXT_PUBLIC_AUTH_MODE=jwt`).
   `DevAuthGuard` remains only as an explicit, documented local/
   trusted-operator fallback (`AUTH_MODE=dev`) — see
   [Auth limitation](#auth-limitation) below.
5. ~~In-process generation, no worker process.~~ **Resolved in Phase 3K
   (generation queue)**: generation is now scheduled on a durable
   BullMQ/Redis-backed queue (`GenerationQueueService`/`GenerationQueueProcessor`,
   see `apps/api/docs/local-generation-pipeline.md`'s "Durable generation
   queue (Phase 3K)" section) instead of the old in-process
   `GenerationTaskRunner`. Multiple API instances can now safely run behind a
   load balancer — BullMQ distributes queued jobs across whichever instance's
   worker claims each one, and a redeploy no longer silently drops an
   in-flight job (it's durably queued in Redis, not held only in one
   process's memory). The worker now runs as its own entrypoint
   (`apps/api/src/worker.ts`, `ENABLE_GENERATION_WORKER=true`) separate from
   the HTTP server — see "Worker process separation" in
   `apps/api/docs/local-generation-pipeline.md`.
   `GenerationJobRecoveryService` remains as a second-layer fail-safe for
   whatever BullMQ's own stalled-job detection doesn't catch.
6. ~~`ru`/`pl` PDF output is not production-ready.~~ **Resolved** —
   `apps/api/src/pdf/pdf-renderer.ts` embeds Noto Sans (OFL-licensed,
   Latin/Cyrillic/Greek coverage), so `ru`/`pl` books render correctly. See
   "Font / Unicode support" in `apps/api/docs/pdf-rendering.md`.

## Things already in good shape (no fix needed)

- **CORS** is env-driven (`ALLOWED_ORIGINS`, `apps/api/src/main.ts`), not
  hardcoded to localhost — just needs the production origin(s) set.
- **API base URL** on the web side is env-driven
  (`NEXT_PUBLIC_API_URL`, `apps/web/src/lib/api/client.ts` and `asset-url.ts`),
  defaulting to `localhost:4000` only for local dev.
- **Health check** already exists at `GET /api/health`, checking DB and Redis
  connectivity (`apps/api/src/health/health.controller.ts`).
- **Migrations** are tracked in `apps/api/prisma/migrations/` and applied via
  `prisma migrate deploy` in CI (`.github/workflows/ci.yml`) — the command
  works, it's just not invoked from inside the Docker image.
- **Build/start scripts** exist and are correct for both apps
  (`@book/api`: `build` → `tsc`, `start` → `node dist/main`; `@book/web`:
  `build` → `next build`, `start` → `next start`).
- **Port binding**: API binds `0.0.0.0` (not `localhost`) and reads `PORT` from
  env, so it works behind any container/PaaS port-mapping scheme.
- **Docker image build**: multi-stage, non-root user, verified to actually
  build and boot as of Phase 5C (see
  [Phase 5C: Docker build verification](#phase-5c-docker) above) — it needed
  three real fixes first, so treat "the Dockerfile looks right" claims in
  earlier phases as unverified until now.

## Minimal fixes made this phase

- **`apps/api/src/config/env.schema.ts`**: `ANTHROPIC_API_KEY`, `FAL_API_KEY`,
  and the four `R2_*` credential vars were required (`.min(1)`) but read by no
  code path in the repo — every deploy had to fabricate credentials for
  providers that don't exist yet. Changed to optional; `OPENAI_API_KEY`
  (actually read by the real story/image providers) is unchanged and still
  required.

  **Follow-up fix (later pass)**: the claim above ("still required") was
  itself a bug — `OPENAI_API_KEY` was `z.string().min(1)` unconditionally,
  so the API refused to boot in the default mock/mock configuration even
  though nothing on that path calls OpenAI. `story-generation-provider.factory.ts`
  / `image-generation-provider.factory.ts` already gated their own
  `OPENAI_API_KEY` requirement correctly on the selected provider; the env
  schema just didn't match. Fixed via `.superRefine()`: `OPENAI_API_KEY` is
  now optional at the schema level and only required when
  `STORY_GENERATION_PROVIDER` or `IMAGE_GENERATION_PROVIDER_TOKEN` is
  (case-insensitively) `"openai"` — matching what `.env.example` and this
  doc's [Required env vars](#required-env-vars-production) section already
  claimed. See `env.schema.spec.ts` for coverage of both the mock-mode-boots
  and openai-without-key-fails cases.
- **`.env.example`**: updated comments to match — those vars are now shown
  commented-out/optional with a note on why. `OPENAI_API_KEY` itself is now
  also commented out in the default mock/mock template (see follow-up fix
  above).
- **`apps/api/Dockerfile`**: added a `HEALTHCHECK` instruction wired to the
  existing `/api/health` endpoint (container orchestrators can now detect an
  unhealthy instance), and a comment clarifying that migrations are **not**
  run automatically by the image.
- **`apps/web/.env.example`**: added (didn't exist before), documenting
  `NEXT_PUBLIC_API_URL`.

No behavior changes for local dev or CI — `OPENAI_API_KEY` and all storage/DB
requirements are unchanged; only unused required vars were relaxed.

**Phase 5C** fixed the four issues in
[Phase 5C: Docker build verification](#phase-5c-docker) above:
`apps/api/Dockerfile` (build `@book/types` before `apps/api`; preserve
`node_modules` directory depth in the runtime stage instead of flattening it;
install `openssl` in both build and runtime Alpine stages),
`apps/api/prisma/schema.prisma` (pin `binaryTargets` explicitly), and
`apps/api/src/auth/auth.module.ts` (export `UsersModule` alongside
`DevAuthGuard` so `BooksModule` can resolve the guard's dependency). No test,
typecheck, or web-facing behavior changes — `pnpm --filter @book/api test`
(425 tests), `pnpm --filter @book/api typecheck`,
`pnpm --filter @book/web test` (142 tests),
`pnpm --filter @book/web typecheck`, and `pnpm --filter @book/web build` all
still pass unchanged.

## Storage decision note {#storage-decision}

| | `LocalPdfStorage` | `CloudPdfStorage` (s3/r2) | `LocalImageAssetStorage` | `CloudImageAssetStorage` (s3/r2) |
|---|---|---|---|---|
| Implemented? | Yes | Yes, fully implemented and wired | Yes | Yes, fully implemented and wired (Phase 5B) |
| Works locally? | Yes, zero config | Yes, needs real/MinIO bucket | Yes, zero config | Yes, needs real/MinIO bucket |
| Safe in production? | No — ephemeral fs, single instance only | Yes | No — same ephemeral fs risk | Yes |
| Required env vars | none | `PDF_STORAGE_DRIVER=s3\|r2`, `PDF_STORAGE_BUCKET`, `PDF_STORAGE_REGION`, `PDF_STORAGE_ACCESS_KEY_ID`, `PDF_STORAGE_SECRET_ACCESS_KEY`, `PDF_STORAGE_ENDPOINT` (r2 only) | none | `IMAGE_STORAGE_DRIVER=s3\|r2` only — reuses the same `PDF_STORAGE_*` credential vars above |
| Selected via | `PDF_STORAGE_DRIVER` (default `local`) | same | `IMAGE_STORAGE_DRIVER` (default `local`) | same |

- `PdfStorage` is a clean interface (`apps/api/src/pdf/pdf-storage.ts`) with
  both a local and a fully working S3-compatible (AWS S3 or Cloudflare R2)
  implementation, selected at DI time in `apps/api/src/books/books.module.ts`
  via `createPdfStorage(process.env.PDF_STORAGE_DRIVER)`. It is genuinely
  ready to use in production today — just set `PDF_STORAGE_DRIVER=r2` (or
  `s3`) plus the credential vars above. It's exercised by a manual smoke
  script (`pnpm --filter @book/api smoke:pdf-storage`), not by the normal
  test suite (which stays offline/local).
- `ImageAssetStorage` (`apps/api/src/images/image-asset-storage.ts`) mirrors
  the same interface shape *intentionally* so a cloud-backed implementation
  could be dropped in later. **Phase 5B added that implementation**:
  `CloudImageAssetStorage` is an S3-compatible driver (AWS S3 or Cloudflare
  R2), selected at DI time via
  `createImageAssetStorage(process.env.IMAGE_STORAGE_DRIVER)` in
  `apps/api/src/books/books.module.ts`, mirroring `CloudPdfStorage`'s
  constructor/error-handling/not-found conventions closely. It deliberately
  reuses the same `PDF_STORAGE_BUCKET`/`PDF_STORAGE_REGION`/`PDF_STORAGE_ENDPOINT`/
  `PDF_STORAGE_ACCESS_KEY_ID`/`PDF_STORAGE_SECRET_ACCESS_KEY`/
  `PDF_STORAGE_FORCE_PATH_STYLE` credentials as PDF storage (see
  `readCloudConfig` in `apps/api/src/pdf/pdf-storage.ts`, now parameterized
  with an env-var-name label so its error messages can say
  `IMAGE_STORAGE_DRIVER` instead of `PDF_STORAGE_DRIVER` when reused this
  way) — only the driver switch (`IMAGE_STORAGE_DRIVER`) is separate, so no
  new bucket/credential vars were needed. Generated images are written under
  an `images/` key prefix in that same bucket
  (`images/<bookId>/<slot>.<ext>`), distinct from the `previews/` prefix PDFs
  use. Like `CloudPdfStorage`, it's covered by tests that mock the S3 client
  (`apps/api/src/images/image-asset-storage.spec.ts`) — no real S3/R2 network
  access in the normal test suite.

## Auth limitation note {#auth-limitation}

- **Current behavior (as of Phase 6C)**: real auth exists end-to-end.
  Backend (Phase 6B): `POST /api/auth/{register,login,refresh,logout}` and
  `GET /api/auth/me`, bcrypt-hashed passwords, short-lived JWT access
  tokens, and rotating refresh tokens (with reuse detection) in an
  `HttpOnly` cookie. Frontend (Phase 6C): `/login`, `/register` pages, an
  `AuthProvider` holding the access token in memory (never
  `localStorage`), `Authorization: Bearer` on authenticated requests, a
  silent refresh-and-retry-once on `401`, and `/dashboard/*` routes
  redirecting to `/login` when signed out. Protected routes
  (`BooksController`, `AuthController#getMe`) use `AuthModeGuard`, which
  picks `JwtAuthGuard` or `DevAuthGuard` per request from `AUTH_MODE`
  (`dev` | `jwt`, defaults to `jwt`); the web app mirrors this with
  `NEXT_PUBLIC_AUTH_MODE`. See `apps/api/src/auth/`,
  `apps/web/src/lib/auth/`, and `docs/auth-architecture.md` for the full
  design.
- **`DevAuthGuard` fallback**: kept only as a documented local/
  trusted-operator convenience (`AUTH_MODE=dev` + matching
  `NEXT_PUBLIC_AUTH_MODE=dev`) — no login screen, identity via a hardcoded
  `x-user-email` header. `DevAuthGuard` itself still refuses to run when
  `NODE_ENV=production` regardless of `AUTH_MODE`, as a safety net against
  accidental misconfiguration.
- **Deactivated-user hardening (later pass)**: `JwtAuthGuard`, `AuthService.login`,
  and `AuthService.refresh` all now reject a user with `deactivatedAt` set —
  previously only a code comment in `jwt-auth.guard.ts` claimed this
  ("a deactivated account... takes effect immediately") without the schema
  field actually being checked anywhere. Login/refresh reuse the existing
  generic "invalid credentials"/"invalid token" messages rather than a
  distinct "account deactivated" message, matching this codebase's existing
  no-enumeration policy. See `apps/api/src/auth/*.spec.ts`.
- **Why this is still private/internal-only**: real credential verification
  removes the identity-spoofing risk `DevAuthGuard` had, rate limiting
  (Phase 6E) now caps brute-force/credential-stuffing volume, email
  verification (Phase 6F) confirms ownership of the registered address before
  login, password reset (Phase 6G) lets a user recover a forgotten password
  without support intervention, and a real transactional email provider
  (Phase 6H) means verification/reset emails now reach real inboxes when
  configured — but there is still no OAuth. That's the remaining gap before
  public exposure, not the identity model itself.
- **What's left**: removing the `x-user-email`/`x-user-name` CORS-allowed
  headers and `DevAuthGuard` entirely once no deployment still relies on dev
  mode (see [Remaining blockers before public production](private-demo-deploy.md)
  in the deploy runbook).
- **Phase 6H (real transactional email provider)**: `EmailModule` now
  selects between `ConsoleEmailService` (default; logs instead of sending)
  and `ResendEmailService` (real HTTP calls to the Resend API) via
  `createEmailService` (`apps/api/src/email/email-provider.factory.ts`),
  driven by `EMAIL_PROVIDER=console|resend`. Selecting `resend` without
  `RESEND_API_KEY`/`EMAIL_FROM` set fails fast at boot (`env.schema.ts`
  `superRefine`, mirroring the existing `OPENAI_API_KEY` conditional
  requirement). `AuthService` is unchanged — it still depends only on the
  `EmailService` interface, so the register/login/verify/reset flows behave
  identically regardless of which provider is active. See
  [`docs/auth-architecture.md` §16](auth-architecture.md#16-phase-6h--real-transactional-email-provider).
- **Phase 6F (email verification)**: new users register as unverified
  (`User.emailVerified: false`); `AuthService.register` mints a single-use,
  24-hour, SHA-256-hashed token (`User.emailVerificationTokenHash`/
  `emailVerificationExpiresAt` — only the hash is ever persisted) and hands
  the raw token to a new `EmailService` abstraction
  (`apps/api/src/email/email.service.ts`), mirroring the `PdfStorage`/
  `ImageAssetStorage` boundary pattern. The only implementation today,
  `ConsoleEmailService`, logs the verification link instead of sending real
  email — no third-party provider is wired up yet. `POST
  /api/auth/verify-email` hashes the submitted token, verifies the user, and
  clears the hash/expiry (so a token cannot be replayed after success);
  `POST /api/auth/resend-verification` issues a fresh token and invalidates
  the old one, always responding the same way regardless of whether the
  email exists, is already verified, or is deactivated (no account-existence
  leak). Both new endpoints are behind the existing `AuthRateLimitGuard`.
  `AuthService.login` now rejects an unverified account with `401
  { "error": "Email is not verified", "code": "EMAIL_NOT_VERIFIED" }` —
  **registration itself is unaffected** and still auto-signs the new user in,
  matching the existing "no separate login step" UX; only a *subsequent*
  login attempt (e.g. after logging out) is gated on verification. See
  [`docs/auth-architecture.md` §14](auth-architecture.md#14-phase-6f--email-verification).
- **Phase 6G (password reset)**: `POST /api/auth/request-password-reset`
  always returns `200 { "ok": true }` regardless of whether the email exists
  or is deactivated (same no-enumeration policy as Phase 6F); for a genuine
  account it mints a single-use, 30-minute, SHA-256-hashed token
  (`User.passwordResetTokenHash`/`passwordResetExpiresAt` — only the hash is
  ever persisted) and sends it via the same `EmailService` boundary
  (`sendPasswordResetEmail`, logged by `ConsoleEmailService` in dev/test).
  `POST /api/auth/reset-password` hashes the submitted token, rejects an
  unknown/expired match with `400
  { "error": "Invalid or expired reset token", "code": "INVALID_RESET_TOKEN" }`,
  and on success hashes the new password, clears the token (single-use), and
  revokes every persisted `RefreshToken` for that user so a session
  established before the reset can't outlive it. Both endpoints are behind
  the existing `AuthRateLimitGuard`. See
  [`docs/auth-architecture.md` §15](auth-architecture.md#15-phase-6g--password-reset).
- **Phase 6E (auth rate limiting)**: added `AuthRateLimitGuard`
  (`apps/api/src/auth/auth-rate-limit.guard.ts`), applied via `@UseGuards` to
  `POST /api/auth/{register,login,refresh,logout}` (not `GET /api/auth/me`,
  which already requires a valid bearer token and isn't a credential-guessing
  target). Backed by `RateLimiterService`
  (`apps/api/src/rate-limit/rate-limiter.service.ts`) — a small, dependency-free,
  in-memory fixed-window counter keyed by IP (+ request email when present, so
  one targeted email can't exhaust the budget for every other user sharing an
  IP). Configurable via `AUTH_RATE_LIMIT_WINDOW_MS` /
  `AUTH_RATE_LIMIT_MAX_ATTEMPTS` (default 15 min / 10 attempts — generous
  enough not to interfere with local dev/demo use). Exceeding the limit
  returns `429 { "error": "Too many requests", "code": "RATE_LIMITED" }`
  (no detail on which key was hit, to avoid email enumeration).
  **In-memory means single-process only** — correct for this app's current
  single-instance deploy target (see
  [Recommended deployment architecture](#recommended-deployment-architecture)
  below), but a future multi-instance deploy needs a shared store (e.g.
  Redis, already provisioned for other purposes — see
  [Required services](#required-services)) behind the same
  `consume()`/`reset()` shape so counts are consistent across instances.
  No existing auth behavior, JWT cookies, or refresh flow changed; see
  `apps/api/src/rate-limit/rate-limiter.service.spec.ts` and
  `apps/api/src/auth/auth-rate-limit.guard.spec.ts` for coverage.
- **Phase 6D (JWT mode end-to-end verification)**: confirmed the Phase 6B/6C
  implementation actually works in real `AUTH_MODE=jwt` (ownership isolation,
  401-retry-once, session restore, route protection, `x-user-email` ignored
  in `jwt` mode — all already had passing tests). Found and fixed two real
  bugs: the root `.env.example` shipped `AUTH_MODE=dev` while
  `apps/web/.env.example` already defaulted to `NEXT_PUBLIC_AUTH_MODE=jwt`
  (a mismatch that 401s every request if copied verbatim, now both default
  to `jwt`), and a mid-session refresh failure previously left the app
  showing a generic error banner forever instead of redirecting to
  `/login` (fixed via a `storyme:auth-expired` event —
  `apps/web/src/lib/api/client.ts` /
  `apps/web/src/lib/auth/auth-context.tsx`). Full writeup, cookie/CORS
  verification, and the manual browser checklist (no E2E framework exists
  yet) live in
  [`docs/auth-architecture.md` §12](auth-architecture.md#12-phase-6d--jwt-mode-verification).

## Recommended deployment architecture

Since "Worker process separation" in
[`apps/api/docs/local-generation-pipeline.md`](../apps/api/docs/local-generation-pipeline.md),
the API and the BullMQ generation worker are two independently deployable
processes built from the same image — this is now a **four-service**
topology, not three:

- **Web**: `apps/web` on Vercel (or any Node host) — no Docker needed, `next
  build` / `next start`. Confirmed in Phase 5D: build/env assumptions already
  correct, see [Phase 5D: Web deployment readiness](#phase-5d-web) above for
  the full checklist.
- **API**: `apps/api/Dockerfile`, start command `node dist/main`
  (`pnpm --filter @book/api start:prod:api`) — serves `/api/*` only, and by
  default (`ENABLE_GENERATION_WORKER` unset/`false`) never registers the
  BullMQ generation processor. Since Phase 3K (see
  [Known blockers](#known-blockers) item 5), BullMQ already distributes
  generation jobs safely across instances, so the API tier can now scale
  horizontally on request load alone, independent of generation throughput.
  What still favors care before scaling out: the default `local` storage
  drivers (`LocalPdfStorage`/`LocalImageAssetStorage`) write to the
  container's own filesystem, not shared across instances (set
  `PDF_STORAGE_DRIVER`/`IMAGE_STORAGE_DRIVER=s3`/`r2` before scaling out).
- **Worker**: same `apps/api/Dockerfile`/image, start command
  `node dist/worker` (`pnpm --filter @book/api start:prod:worker`) instead of
  the API's `node dist/main` — a Railway/Fly/Render service pointed at the
  identical build but with its start command overridden, no separate
  Dockerfile needed. Consumes `book-generation` BullMQ jobs; exposes no HTTP
  port at all (do **not** point a load balancer or healthcheck path at it —
  see [Build/run commands](#build-run-commands) below for a process-level
  health check instead). `GenerationJobRecoveryService` runs its own
  independent sweep on every boot of **both** the API and the worker (safe —
  each write is a plain last-write-wins `update` — but redundant, not a
  shared distributed lock).
- **Database**: managed Postgres (Neon, Supabase, RDS, etc.) — schema and
  migrations are already Postgres-specific and ready. Shared by the API and
  worker services (both need `DATABASE_URL`).
- **Redis**: managed Redis (Upstash, Redis Cloud) — now on the critical path
  (BullMQ), shared by the API (producer: `GenerationQueueService.enqueue`)
  and worker (consumer: `GenerationQueueProcessor`) services; both need the
  same `REDIS_URL`.
- **PDF storage**: Cloudflare R2 via `PDF_STORAGE_DRIVER=r2` — already fully
  implemented, see [Storage decision note](#storage-decision).
- **Image storage**: Cloudflare R2 via `IMAGE_STORAGE_DRIVER=r2`, reusing the
  same bucket/credentials as PDF storage — now fully implemented, see
  [Storage decision note](#storage-decision).

## Required services

- PostgreSQL 16 (see `docker-compose.yml` for the dev version pin)
- Redis 7
- Object storage bucket (S3 or R2) — shared by both PDF previews
  (`PDF_STORAGE_DRIVER=s3|r2`) and generated images
  (`IMAGE_STORAGE_DRIVER=s3|r2`) under different key prefixes.
- Both the **api** and **worker** services (see
  [Recommended deployment architecture](#recommended-deployment-architecture)
  above) — two separate deployed processes from the same image.

## Required env vars (production)

See `.env.example` for the full annotated list. Vars that matter for a real
deploy (beyond local dev defaults):

- `ENABLE_GENERATION_WORKER` — process-topology switch (see "Worker process
  separation" in
  [`apps/api/docs/local-generation-pipeline.md`](../apps/api/docs/local-generation-pipeline.md)):
  - **api service**: leave unset (defaults to `false`) — the API must not
    also consume generation jobs.
  - **worker service**: not read by `worker.ts` at all — it always enables
    the processor regardless of this var. Setting it has no effect on the
    worker service; it only matters for the api service.
- `DATABASE_URL`, `REDIS_URL` — point at managed services, not
  `docker-compose` containers. Required by **both** the api and worker
  services (Redis is now on the critical path for the worker, not just
  cache/health-check plumbing).
- `JWT_SECRET`, `JWT_REFRESH_SECRET` — generate real 32+ char secrets
  (`openssl rand -hex 32`); unused by any code path today but validated at
  startup ahead of the real-auth phase.
- `AUTH_RATE_LIMIT_WINDOW_MS`, `AUTH_RATE_LIMIT_MAX_ATTEMPTS` — optional,
  default to 15 minutes / 10 attempts; only worth overriding if that default
  is too strict/loose for a specific deployment. See the
  [Auth limitation note](#auth-limitation) Phase 6E entry above.
- `ALLOWED_ORIGINS` — set to the deployed web app's origin(s).
- `PORT` — usually set by the host; API already respects it.
- `OPENAI_API_KEY` — required only if `STORY_GENERATION_PROVIDER=openai` or
  `IMAGE_GENERATION_PROVIDER_TOKEN=openai`; otherwise the mock providers need
  no key.
- `PDF_STORAGE_DRIVER=r2` (or `s3`) plus `PDF_STORAGE_BUCKET`,
  `PDF_STORAGE_REGION`, `PDF_STORAGE_ACCESS_KEY_ID`,
  `PDF_STORAGE_SECRET_ACCESS_KEY`, and `PDF_STORAGE_ENDPOINT` (r2 only) — to
  avoid the local-filesystem durability problem. **Required, not just
  recommended, on the worker service**: `node dist/worker` now refuses to
  boot when `NODE_ENV=production` and this is left at its `local` default —
  see [PDF storage: separate worker guard](#pdf-storage-worker-guard).
  Set it identically on the **api** service too — the api and worker must
  agree on the same driver/bucket/credentials for previews to work at all.
- `IMAGE_STORAGE_DRIVER=r2` (or `s3`) — same durability fix for generated
  images. No separate credentials needed; it reuses the `PDF_STORAGE_*` vars
  above.
- `NEXT_PUBLIC_API_URL` (web app) — the deployed API's public URL.
- `ANTHROPIC_API_KEY`, `FAL_API_KEY`, `R2_*` (asset upload vars),
  `STRIPE_*`, `GOOGLE_*` — all optional; reserved for features not built yet.

## Build/run commands {#build-run-commands}

### Local (no Docker)

```
pnpm install --frozen-lockfile
pnpm --filter @book/types build
pnpm --filter @book/api prisma:generate
pnpm build   # turbo run build across all apps/packages

# API (HTTP server only — does not consume generation jobs)
pnpm --filter @book/api start:api        # node dist/main

# Worker (consumes generation jobs — no HTTP server)
pnpm --filter @book/api start:worker     # node dist/worker

# Web
pnpm --filter @book/web start        # or deploy to Vercel
```

For local development with hot-reload, run the API and worker as two
separate terminal processes (both need `docker-compose.yml`'s Postgres/Redis
running):

```
# Terminal 1 — API + web
pnpm --filter @book/api dev            # nest start --watch (main.ts)
pnpm --filter @book/web dev

# Terminal 2 — worker
pnpm --filter @book/api dev:worker     # nest start --watch --entryFile worker
```

A single-process local setup (no separate worker terminal) is still possible
by setting `ENABLE_GENERATION_WORKER=true` in `apps/api/.env` before running
`pnpm --filter @book/api dev` — this restores the pre-worker-separation
behavior for a quick local check, but should not be used in any deployed
environment (see "Worker process separation" in
`apps/api/docs/local-generation-pipeline.md`).

### Docker (API only — verified working end-to-end in Phase 5C)

Build, from the repo root (the build context must be the repo root, not
`apps/api/`, since the Dockerfile copies root-relative workspace manifests):

```
docker build -f apps/api/Dockerfile -t storyme-api:local .
```

Run, pointing at real Postgres/Redis (a managed DB/Redis in production, or
the `docker-compose.yml` services for a local smoke test — note the compose
Postgres publishes on host port `5433`, not the default `5432`):

```
docker run -d --name storyme-api -p 4000:4000 \
  -e DATABASE_URL="postgresql://<user>:<pass>@<host>:5432/<db>" \
  -e REDIS_URL="redis://<host>:6379" \
  -e JWT_SECRET="$(openssl rand -hex 32)" \
  -e JWT_REFRESH_SECRET="$(openssl rand -hex 32)" \
  -e OPENAI_API_KEY="sk-..." \
  -e ALLOWED_ORIGINS="https://your-web-app.example.com" \
  storyme-api:local
```

Verify:

```
curl http://localhost:4000/api/health
# {"status":"ok","info":{"db":{"status":"up"},"redis":{"status":"up"}},...}

docker inspect --format='{{.State.Health.Status}}' storyme-api
# healthy
```

The image does **not** run migrations automatically — run the migration
command below against the target database before starting the container
(first boot against an unmigrated database will fail `/api/health`'s DB
check, not crash the process).

### Docker (worker)

Same image as above — only the container's start command differs, so no
second Dockerfile or build step is needed. On Railway (or any host that lets
you override a service's start command against a shared build), point the
**worker** service at the same repo/Dockerfile as the **api** service, then
set its start command to:

```
node dist/worker
```

instead of the api service's default `node dist/main` (the Dockerfile's
`CMD`). Locally, the equivalent is:

```
docker run -d --name storyme-worker \
  -e DATABASE_URL="postgresql://<user>:<pass>@<host>:5432/<db>" \
  -e REDIS_URL="redis://<host>:6379" \
  -e JWT_SECRET="$(openssl rand -hex 32)" \
  -e JWT_REFRESH_SECRET="$(openssl rand -hex 32)" \
  storyme-api:local \
  node dist/worker
```

The worker opens no HTTP port, so it has no `/api/health` to curl and no
`EXPOSE`/`HEALTHCHECK` to reuse from the Dockerfile — verify it's alive via
`docker logs storyme-worker` (expect `Generation worker started — consuming
book-generation jobs (no HTTP server).`) or a process-level check
(`docker inspect --format='{{.State.Running}}' storyme-worker`), not an HTTP
healthcheck.

## Troubleshooting: a book stuck in `char_build`/`queued` {#troubleshooting-stuck-queued}

Symptom: `GET /api/books/:id/generation-diagnostics` shows the book's status
stuck at a non-terminal value (e.g. `char_build`), `latestJob.status` stuck at
`queued` (never advancing to `running`), and
`generationMetadata.storyProvider`/`imageProvider` both `unknown` (they're
only ever populated once an `AgentLog` row exists for that book — i.e. once
the worker actually starts running the pipeline). This means the API
successfully enqueued the job (`GenerationQueueService.enqueue` resolved,
`GenerationJob` row created) but **no worker process ever picked it up**.

Check, in order:

1. **Is the worker service actually running `node dist/worker`, not
   `node dist/main`?** This is the most common misconfiguration on Railway
   (or any host where the worker shares the api's Dockerfile with an
   overridden start command): the Dockerfile's own `CMD` is `node dist/main`
   (see `apps/api/Dockerfile`) — if a service's custom start command was
   never set, or got reset by a redeploy/rebuild, that "worker" service is
   silently running as a second API instance instead, and nothing is
   consuming `book-generation` jobs. Since this phase, both entrypoints log a
   one-line startup banner (`Bootstrap`/`Worker` logger) — check the actual
   deployed service's boot logs for `mode=api` vs. `mode=worker`, not just
   the Railway dashboard's configured start command:
   - API: `mode=api | worker enabled=false | REDIS_URL set=true | DATABASE_URL set=true`
   - Worker: `mode=worker | worker enabled=true | queue=book-generation | processor registered=true | REDIS_URL set=true | DATABASE_URL set=true`

   If the worker service's logs show `mode=api`, its start command is wrong —
   fix it in the platform's service settings (see
   [Worker start command](#build-run-commands) above) and redeploy.
2. **Do the api and worker services point at the same Redis/Postgres?**
   `REDIS_URL set=`/`DATABASE_URL set=` in the startup log only confirms the
   var is non-empty, not that it's the *same* value in both services — a
   worker pointed at a different (e.g. leftover local/staging) Redis instance
   will boot cleanly and log `processor registered=true`, but will never see
   jobs enqueued against the api's Redis. Compare the two services' env vars
   directly in the platform dashboard.
3. **Did the worker crash after boot?** A clean `mode=worker` boot log
   doesn't guarantee the process stayed up — check for a crash loop
   (`restartPolicyMaxRetries` in `railway.json` only covers the api service;
   a worker service needs its own restart policy configured). BullMQ job
   pickup is logged per-job (`GenerationQueueProcessor`): `Picked up job —
   bullmqJobId=... bookId=... generationJobId=...` on pickup, `Job completed
   — ...` or `Job failed — ... error=...` on the two terminal outcomes — a
   worker that boots but never logs any of these for a genuinely queued job
   has either crashed, lost its Redis connection, or (per point 1) isn't
   really running worker mode.
4. **Was the job enqueued at all?** If `latestJob` is `null` (not `queued`),
   the enqueue call itself never happened or never persisted a
   `GenerationJob` row — that's an api-side issue (`BooksService.startGeneration`/
   `retryGeneration`), not a worker problem; check the api service's own logs
   for `Failed to enqueue generation job ...` (`BooksService.enqueueOrThrow`).

## Troubleshooting: PDF ready but preview/download 404s {#troubleshooting-pdf-404}

Symptom: a book reaches `status: 'complete'`, the UI shows "Your PDF is
ready," but clicking **Open PDF**/**Download PDF**
(`GET /api/books/:id/pdf/preview`) returns
`404 { "error": "Not Found", "message": "PDF file not found in storage" }`.

1. **Check `GET /:id/generation-diagnostics`'s new `pdfStorage` field first**
   — it answers this without needing container/log access:
   - `keyPresent: true, previewAvailable: false` — the book claims a PDF was
     saved (`Book.previewPdfUrl` is set) but the **api** process's
     configured `PdfStorage` genuinely cannot find it. This is almost always
     the worker/API storage mismatch below, not a transient error.
   - `keyPresent: false` — generation hasn't reached (or failed before) the
     PDF-render step; the "PDF is ready" UI state shouldn't even be showing
     yet. Check `failedStep`/`errorMessage` instead.
2. **Do the api and worker services have the same `PDF_STORAGE_DRIVER` (and,
   if `s3`/`r2`, the same bucket/credentials)?** This is the root cause this
   phase was written for: `LocalPdfStorage` writes to *that container's own*
   filesystem. If the api and worker are separate Railway services (the
   [recommended deployment architecture](#recommended-deployment-architecture))
   and either one is left on the `local` default, the worker's write is
   invisible to the api's read (or vice versa if the api itself ever ran
   generation) — every preview 404s even though generation reported success.
   Compare `PDF_STORAGE_DRIVER`/`PDF_STORAGE_BUCKET`/`PDF_STORAGE_REGION`/
   `PDF_STORAGE_ENDPOINT` across both services' env vars directly in the
   platform dashboard. **Since this phase, the worker refuses to boot at all
   in production with `PDF_STORAGE_DRIVER=local`** (see
   [PDF storage: separate worker guard](#pdf-storage-worker-guard) above) —
   if the worker is up and generating successfully, its driver is already
   confirmed non-`local`; double-check the **api** service's value matches.
3. **Was this book generated before the fix above was deployed?** A book
   already `complete` with `previewPdfUrl` pointing at a PDF that only ever
   existed in the worker's now-redeployed (and wiped) local container cannot
   be recovered — the bytes are gone. Retry generation
   (`POST /:id/retry-generation`) once both services agree on a shared
   (`s3`/`r2`) driver; the fresh run will persist through the real backend.
4. **If both services already agree on `s3`/`r2`** and `previewAvailable` is
   still `false`, this is a genuine storage backend problem (wrong
   bucket/region, expired credentials, an object actually deleted out of
   band) rather than the worker/API mismatch — check
   `PDF_STORAGE_BUCKET`/`PDF_STORAGE_REGION`/credentials against the actual
   bucket, not just that both services' env vars match each other.

## Migration command

```
pnpm --filter @book/api prisma:migrate:deploy
```

Run this as a separate release/deploy step, against the production database,
**before** starting the new API version — the Docker image intentionally
does not run it (see [Known blockers](#known-blockers) above). This is the
same command CI uses (`.github/workflows/ci.yml`), just pointed at
`DATABASE_URL` for the target environment instead of the CI database.

**Rollback caution**: `prisma migrate deploy` only applies forward
migrations — there is no automated rollback. Prisma migrations in this repo
are plain SQL (`apps/api/prisma/migrations/*/migration.sql`); reverting a bad
migration in production means writing and applying a new forward migration
that undoes the change, not running the old one backwards.

## Suggested next phase

1. Add the migration-deploy step to whatever deploy pipeline is chosen (CI
   job, release script, or platform release-phase hook), since the container
   itself intentionally doesn't run it.
2. ~~A real transactional email provider behind `EmailService`~~ **Resolved
   in Phase 6H** — `ResendEmailService` is available behind
   `EMAIL_PROVIDER=resend`; a real deploy just needs `RESEND_API_KEY` and
   `EMAIL_FROM` set (see [Auth limitation note](#auth-limitation) and
   `docs/auth-architecture.md` §16). OAuth remains the last documented auth
   follow-up.

## Private demo runbook

Phase 5E turned the architecture/config decisions above into an actual
step-by-step deploy procedure — see
**[docs/private-demo-deploy.md](private-demo-deploy.md)** for exact env
vars, setup order, build/migrate/run commands, a smoke test checklist, and
rollback notes. Scoped to a private/internal demo only, per the auth
limitation above.

Storage (PDF + image) is no longer on this list — both `CloudPdfStorage` and
`CloudImageAssetStorage` are implemented, tested (mocked S3 client), and
wired via `PDF_STORAGE_DRIVER`/`IMAGE_STORAGE_DRIVER` (Phase 5B).

The API Docker image itself is no longer on this list either — it now
builds, boots, and passes its healthcheck end-to-end (Phase 5C).

The web app's hosting decision is no longer on this list either — Vercel (or
any Node host via `next build`/`next start`) is the recommended path, its
build/env/CORS assumptions were verified correct, and no Dockerfile was
needed (Phase 5D). What remains after Phase 5D is exactly the two items
above: wiring the migration-deploy step into an actual deploy pipeline, and
the real-auth phase.
