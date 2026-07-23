# Local MVP demo guide

How to run StoryMe locally end-to-end: create a book, generate it, and
download the PDF. Everything below uses the default **mock** generation
mode — no OpenAI key required, no network calls, fully deterministic.

## Prerequisites

- Node.js ≥ 20
- pnpm ≥ 9 (`corepack enable` or `npm i -g pnpm`)
- Docker (for local Postgres/Redis/MinIO)

## 1. Install dependencies

```bash
pnpm install
```

## 2. Start local infrastructure

```bash
docker compose up -d
```

Starts Postgres (`localhost:5433`), Redis (`localhost:6379`), and MinIO
(`localhost:9000`). Only Postgres is required for the demo flow below — Redis
and MinIO are reserved for future queue/cloud-storage work and aren't on the
critical path yet.

## 3. Configure environment

```bash
cp .env.example apps/api/.env
```

The defaults in `.env.example` already point at the Docker Postgres instance
and use mock story/image generation — no edits needed for a local demo. Leave
`STORY_GENERATION_PROVIDER` and `IMAGE_GENERATION_PROVIDER` unset (or
`"mock"`) unless you intend to spend real OpenAI credits (see
[Troubleshooting](#troubleshooting)).

The web app needs no `.env` — it defaults to `http://localhost:4000/api`. Set
`NEXT_PUBLIC_API_URL` in `apps/web/.env.local` only if the API runs elsewhere.

## 4. Run database migrations

```bash
pnpm --filter @book/api prisma:migrate:deploy
```

## 5. Run the API

```bash
pnpm --filter @book/api dev
```

Runs on `http://localhost:4000`. Confirm it's up:

```bash
curl http://localhost:4000/api/health
```

## 6. Run the web app

In a second terminal:

```bash
pnpm --filter @book/web dev
```

Runs on `http://localhost:3000`.

## 7. Sign in

The web app supports two auth modes, controlled by `NEXT_PUBLIC_AUTH_MODE`
(`apps/web/.env.example`), which must match the API's `AUTH_MODE`
(`apps/api/.env`). **`jwt` is the default and recommended mode** — use it
unless you have a specific reason to want the old shared-identity shortcut:

- `jwt` (default, recommended) — real login. Open
  `http://localhost:3000/register`, create an account (email + password, 8+
  chars with 1 uppercase and 1 number), and you're redirected straight into
  `/dashboard` already signed in. Next time, use `/login` instead.
  `/dashboard/*` redirects anonymous visitors to `/login?next=...`; a **Log
  out** button in the dashboard header ends the session. Closing the tab and
  reopening it restores the session silently (refresh cookie), no need to log
  in again unless the 7-day refresh token has expired.
  - **Email verification (Phase 6F)**: new accounts start unverified — a
    banner in the dashboard header offers to resend the verification link.
    Registration itself still signs you in immediately either way, but a
    _later_ `/login` attempt (e.g. after clicking **Log out**) is rejected
    with `401 EMAIL_NOT_VERIFIED` until the account is verified. No real
    email is sent locally — the API logs the verification link to its
    console instead (`[ConsoleEmailService] Verification email for
<email>: http://localhost:3000/verify-email?token=...`); copy that URL
    into the browser to verify. See
    [docs/auth-architecture.md §14](auth-architecture.md#14-phase-6f--email-verification).
  - **Password reset (Phase 6G)**: click **Forgot password?** on `/login` to
    request a reset link. As with verification, no real email is sent
    locally — the API logs it instead (`[ConsoleEmailService] Password reset
email for <email>: http://localhost:3000/reset-password?token=...`);
    copy that URL into the browser to set a new password. The link expires
    after 30 minutes and can only be used once. See
    [docs/auth-architecture.md §15](auth-architecture.md#15-phase-6g--password-reset).
  - **Real email (Phase 6H, optional)**: `ConsoleEmailService` (the
    console-logging behavior above) is the default and is what local dev
    should keep using — no setup, no cost, no risk of accidentally emailing a
    real inbox from a dev environment. To instead send real verification/
    reset email locally, set `EMAIL_PROVIDER="resend"` plus `RESEND_API_KEY`
    and `EMAIL_FROM` in `apps/api/.env` (see `.env.example`); the app refuses
    to boot if `EMAIL_PROVIDER=resend` is set without both. See
    [docs/auth-architecture.md §16](auth-architecture.md#16-phase-6h--real-transactional-email-provider).
- `dev` — no login screen, no accounts. Every API request is scoped to a
  single dev user identified by the `x-user-email` header, sent automatically
  by the web app (see `DevAuthGuard`). Set both `AUTH_MODE=dev` (API) and
  `NEXT_PUBLIC_AUTH_MODE=dev` (web) for this — a mismatch 401s every request.
  Useful for quick manual pipeline iteration when you don't want to deal with
  a login form, but it has no credential check at all — see
  [Auth limitation](../docs/deployment-readiness.md#auth-limitation) for why
  this must never be used outside local dev.

## 8. Create a book

1. From the dashboard, click **Create Your First Book** (or **+ New Book**
   if you already have drafts).
2. Fill in the 3-step wizard (child's name/age → story theme/pages → review)
   and submit.
3. You land on the new book's detail page with status `created`.

## 9. Verify generation

Click **Generate Story** on the book detail page. The page polls every 2.5s
and walks through each pipeline stage (`char_build` → `story_plan` → … →
`complete`), rendering story plan, page plan, draft text, illustration plan,
and generated images as each stage finishes. With the mock providers this
takes a few seconds and produces deterministic placeholder text/images — no
OpenAI credits spent.

If generation fails, the detail page shows the failure reason and a **Retry
generation** button.

Books are scoped to the signed-in user (`jwt` mode) — a second registered
user's dashboard is empty and cannot open your book's URL directly (404s).
See [docs/auth-architecture.md §12.4](auth-architecture.md#124-manual-verification-checklist)
for the full manual verification checklist, including this multi-user check.

## 10. Open / download the PDF

Once status reaches `complete`, the PDF section shows **Open PDF** and
**Download PDF**, both backed by `GET /api/books/:id/pdf/preview`. Both
fetch the PDF through the authenticated API client (so the bearer token or
dev header attaches correctly) and open it as a blob URL/download rather
than navigating the browser directly to the API, which under `jwt` mode
can't carry an `Authorization` header. PDFs are written to `apps/api/tmp/`
by the default `LocalPdfStorage` driver — no S3/R2 needed for the demo.

## Troubleshooting

**API not reachable from the web app**
Confirm the API is running (`curl http://localhost:4000/api/health`) and that
`NEXT_PUBLIC_API_URL` (if set) matches where it's listening. Also check
`ALLOWED_ORIGINS` in `apps/api/.env` includes `http://localhost:3000`.

**DB not migrated / Prisma errors on startup**
Run `pnpm --filter @book/api prisma:migrate:deploy` again. If Postgres isn't
reachable, confirm `docker compose ps` shows `storyme-postgres` healthy and
`DATABASE_URL` in `apps/api/.env` matches the Docker port (`5433`).

**"PDF link is not available yet" / PDF not found**
The book must reach `complete` status first — check the status badge and
generation diagnostics panel on the detail page for a failed step. Locally
generated PDFs live under `apps/api/tmp/`; if that directory was deleted
after a book completed, regenerate the book.

**OpenAI key missing / want to use mock provider mode**
Mock mode is the default and needs no key — leave `STORY_GENERATION_PROVIDER`
and `IMAGE_GENERATION_PROVIDER` unset in `apps/api/.env`. To use real
OpenAI generation, set both to `"openai"` and provide a real
`OPENAI_API_KEY`; real image generation costs money per call (see
`REAL_GENERATION_MAX_PAGES` guardrail in `.env.example`).

**"Too many requests" (429) on login/register/refresh**
`/api/auth/*` is rate-limited (`AUTH_RATE_LIMIT_WINDOW_MS` /
`AUTH_RATE_LIMIT_MAX_ATTEMPTS` in `.env.example`, default 10 attempts per 15
minutes — see [docs/auth-architecture.md §13](auth-architecture.md#13-phase-6e--auth-rate-limiting)).
The default shouldn't trip during normal manual testing; if you're
deliberately hammering these endpoints (e.g. scripted testing), either wait
out the window or raise `AUTH_RATE_LIMIT_MAX_ATTEMPTS` in `apps/api/.env` and
restart the API.
