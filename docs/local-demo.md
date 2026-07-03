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
`STORY_GENERATION_PROVIDER` and `IMAGE_GENERATION_PROVIDER_TOKEN` unset (or
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

## 7. Create a book

1. Open `http://localhost:3000` and click **Create Your First Book** (or go
   straight to `http://localhost:3000/dashboard`).
2. Fill in the 3-step wizard (child's name/age → story theme/pages → review)
   and submit.
3. You land on the new book's detail page with status `created`.

The web app supports two auth modes, controlled by `NEXT_PUBLIC_AUTH_MODE`
(`apps/web/.env.example`), which must match the API's `AUTH_MODE`:

- `jwt` (default) — real login. Visit `/register` to create an account, or
  `/login` if you already have one. `/dashboard/*` redirects to `/login` when
  signed out.
- `dev` — no login screen. Every API request is scoped to a dev user
  identified by the `x-user-email` header, sent automatically by the web app
  (see `DevAuthGuard`). Set both `AUTH_MODE=dev` (API) and
  `NEXT_PUBLIC_AUTH_MODE=dev` (web) for this — a mismatch 401s every request.

## 8. Verify generation

Click **Generate Story** on the book detail page. The page polls every 2.5s
and walks through each pipeline stage (`char_build` → `story_plan` → … →
`complete`), rendering story plan, page plan, draft text, illustration plan,
and generated images as each stage finishes. With the mock providers this
takes a few seconds and produces deterministic placeholder text/images — no
OpenAI credits spent.

If generation fails, the detail page shows the failure reason and a **Retry
generation** button.

## 9. Open / download the PDF

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
and `IMAGE_GENERATION_PROVIDER_TOKEN` unset in `apps/api/.env`. To use real
OpenAI generation, set both to `"openai"` and provide a real
`OPENAI_API_KEY`; real image generation costs money per call (see
`REAL_GENERATION_MAX_PAGES` guardrail in `.env.example`).
