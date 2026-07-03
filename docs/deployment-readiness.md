# Deployment Readiness — Phase 5A/5B/5C Audit

Audit of the current MVP's readiness to deploy outside a local dev machine.
Phase 5A was an audit + minimal-cleanup pass; Phase 5B closed the one real
code gap it found by adding `CloudImageAssetStorage`; Phase 5C actually built
and ran the Docker image end-to-end for the first time (previous phases had
only inspected the Dockerfile statically) and fixed what that uncovered.
Nothing here has been deployed to a real host, and no cloud provider,
payments, or real auth were added.

## Current deployability status

**The API's Docker image now builds and boots successfully, verified
end-to-end** (see [Phase 5C: Docker build verification](#phase-5c-docker)) —
this had never actually been built before Phase 5C, and doing so surfaced
three real bugs (two Docker-specific, one an application bug affecting every
run mode) that are now fixed.

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
   credentials.
2. **No `prisma migrate deploy` step in the container.** `apps/api/Dockerfile`
   builds and runs `node dist/main` only — it does not apply migrations.
   Migrations must be run as a separate deploy step (`pnpm --filter @book/api
   prisma:migrate:deploy`) before the new container starts serving traffic.
3. **No web app Dockerfile / hosting decision.** Only `apps/api` has a
   Dockerfile. The web app (`apps/web`) is a standard Next.js app and can run
   on Vercel or any Node host via `next build && next start`, but that choice
   hasn't been made yet.
4. **Dev-only auth.** `DevAuthGuard` trusts a plain `x-user-email` header with
   no credential check (see [Auth limitation](#auth-limitation) below). Fine
   for a local/internal demo; not safe to expose publicly.
5. **In-process generation, no worker process.** `GenerationTaskRunner` runs
   the generation pipeline in the same process as the HTTP server. BullMQ/Redis
   are provisioned but unused for this. Acceptable for a single-instance
   deploy; will need to move to an actual queue+worker before scaling to
   multiple API instances (otherwise a redeploy mid-generation drops the job —
   `GenerationJobRecoveryService` already detects and fails these stale jobs on
   next boot, so this fails safely rather than silently, but the job is lost).

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
- **`.env.example`**: updated comments to match — those vars are now shown
  commented-out/optional with a note on why.
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

- **Current behavior**: `DevAuthGuard` (`apps/api/src/auth/dev-auth.guard.ts`)
  reads a plain `x-user-email` header (optionally `x-user-name`), validates
  only that it looks like an email address, and creates/looks up a matching
  `User` row on the fly — no password, session, or token is ever checked.
  The web app sends fixed dev values (`dev@storyme.local`) on every request
  (`apps/web/src/lib/api/client.ts`).
- **Why this is acceptable for the local demo**: it lets the whole
  create → generate → preview → PDF flow be exercised end-to-end without
  building a login system first, and every downstream consumer
  (`@CurrentUser`, controllers) only depends on `request.user` being
  populated — so the guard is a swappable seam, not something wired
  throughout the codebase.
- **Why it is not production-ready**: anyone can act as any user simply by
  setting an `x-user-email` header to any address — there is no proof of
  identity. Exposing this publicly means no real access control exists.
- **What a real auth phase must add**: credential verification (password
  hash check or OAuth token exchange — `User.passwordHash`,
  `oauthProvider`/`oauthId` and the `RefreshToken` model already exist in the
  schema for this), session/JWT issuance and verification (`JWT_SECRET`/
  `JWT_REFRESH_SECRET` are already validated at startup but nothing signs or
  verifies a token yet), a login/signup surface on the web app, and removal
  of the `x-user-email`/`x-user-name` CORS-allowed headers and `DevAuthGuard`
  itself once replaced.

## Recommended deployment architecture

A minimal, low-ops setup that fits the current single-process design:

- **Web**: `apps/web` on Vercel (or any Node host) — no Docker needed, `next
  build` / `next start`.
- **API**: `apps/api/Dockerfile` on a single-instance container host (e.g.
  Fly.io, Render, Railway) — the in-process generation runner
  (`GenerationTaskRunner`) means horizontal scaling is not yet safe (a second
  instance would run its own independent recovery/polling with no shared
  coordination beyond the DB).
- **Database**: managed Postgres (Neon, Supabase, RDS, etc.) — schema and
  migrations are already Postgres-specific and ready.
- **Redis**: managed Redis (Upstash, Redis Cloud) — currently only used for
  cache/health-check plumbing (BullMQ is installed but not on the critical
  path), so a small instance is enough for now.
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

## Required env vars (production)

See `.env.example` for the full annotated list. Vars that matter for a real
deploy (beyond local dev defaults):

- `DATABASE_URL`, `REDIS_URL` — point at managed services, not
  `docker-compose` containers.
- `JWT_SECRET`, `JWT_REFRESH_SECRET` — generate real 32+ char secrets
  (`openssl rand -hex 32`); unused by any code path today but validated at
  startup ahead of the real-auth phase.
- `ALLOWED_ORIGINS` — set to the deployed web app's origin(s).
- `PORT` — usually set by the host; API already respects it.
- `OPENAI_API_KEY` — required only if `STORY_GENERATION_PROVIDER=openai` or
  `IMAGE_GENERATION_PROVIDER_TOKEN=openai`; otherwise the mock providers need
  no key.
- `PDF_STORAGE_DRIVER=r2` (or `s3`) plus `PDF_STORAGE_BUCKET`,
  `PDF_STORAGE_REGION`, `PDF_STORAGE_ACCESS_KEY_ID`,
  `PDF_STORAGE_SECRET_ACCESS_KEY`, and `PDF_STORAGE_ENDPOINT` (r2 only) — to
  avoid the local-filesystem durability problem.
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

# API
pnpm --filter @book/api start        # node dist/main

# Web
pnpm --filter @book/web start        # or deploy to Vercel
```

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
2. Decide on the web app's host and add its Dockerfile/config only if not
   using Vercel.
3. Real auth phase (see [Auth limitation note](#auth-limitation)) — this
   should happen before any public deploy, not just a private/internal one.

Storage (PDF + image) is no longer on this list — both `CloudPdfStorage` and
`CloudImageAssetStorage` are implemented, tested (mocked S3 client), and
wired via `PDF_STORAGE_DRIVER`/`IMAGE_STORAGE_DRIVER` (Phase 5B).

The API Docker image itself is no longer on this list either — it now
builds, boots, and passes its healthcheck end-to-end (Phase 5C). What
remains after Phase 5C is exactly the three items above: wiring the
migration-deploy step into an actual deploy pipeline, picking the web app's
host, and the real-auth phase.
