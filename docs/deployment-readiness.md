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
5. **In-process generation, no worker process.** `GenerationTaskRunner` runs
   the generation pipeline in the same process as the HTTP server. BullMQ/Redis
   are provisioned but unused for this. Acceptable for a single-instance
   deploy; will need to move to an actual queue+worker before scaling to
   multiple API instances (otherwise a redeploy mid-generation drops the job —
   `GenerationJobRecoveryService` already detects and fails these stale jobs on
   next boot, so this fails safely rather than silently, but the job is lost).
6. **`ru`/`pl` PDF output is not production-ready.** `SupportedLanguage`
   offers Russian and Polish, but the PDF renderer only has PDFKit's
   built-in WinAnsi-only fonts — Cyrillic renders as blank glyphs entirely,
   Polish diacritics are missing. Story generation and layout are unaffected;
   only the exported PDF is wrong. No fonts were embedded in this pass
   pending an explicit licensing decision — see
   `apps/api/docs/pdf-rendering.md#backlog-rupl-pdf-output-is-not-production-ready`
   for the concrete gap and the implementation plan once a font is chosen.

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
  login, and password reset (Phase 6G) lets a user recover a forgotten
  password without support intervention — but there is still no real
  transactional email provider and no OAuth. That's the remaining gap before
  public exposure, not the identity model itself.
- **What's left**: a real email provider behind the `EmailService` interface
  (see [Remaining blockers before public production](private-demo-deploy.md)
  in the deploy runbook), then removing the `x-user-email`/`x-user-name`
  CORS-allowed headers and `DevAuthGuard` entirely once no deployment still
  relies on dev mode.
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

A minimal, low-ops setup that fits the current single-process design:

- **Web**: `apps/web` on Vercel (or any Node host) — no Docker needed, `next
  build` / `next start`. Confirmed in Phase 5D: build/env assumptions already
  correct, see [Phase 5D: Web deployment readiness](#phase-5d-web) above for
  the full checklist.
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
2. A real transactional email provider behind `EmailService` (see
   [Auth limitation note](#auth-limitation)) — real auth (Phase 6B/6C), rate
   limiting (Phase 6E), email verification (Phase 6F), and password reset
   (Phase 6G) are all done end-to-end; this is what's left before any public
   deploy.

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
