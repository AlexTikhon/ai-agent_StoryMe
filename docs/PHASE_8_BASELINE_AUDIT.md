# Phase 8 baseline audit

Audit date: 2026-07-31. Baseline commit: `bc0d49d693ac79e2fb2bc5f2658399328f77fd87` (`Implement Phase 7 product safeguards`). The worktree was clean before this document was added. No history was rewritten and no baseline source code was changed during the audit.

## Startup topology

The complete local application has five runtime roles:

| Role       | Baseline process/service                                                               | Port                                       | Responsibility                                                                                                                                                     |
| ---------- | -------------------------------------------------------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| PostgreSQL | `postgres:16-alpine`                                                                   | main Compose `5433`; disposable E2E `5440` | Prisma application data, generation runs, outbox, publication pointers, credits, and deletion records                                                              |
| Redis      | `redis:7-alpine`                                                                       | main/E2E `6379`/`6380`                     | BullMQ queues, distributed rate limiting, and worker coordination                                                                                                  |
| API        | `pnpm --filter @book/api dev` or `start:e2e`                                           | normal/E2E `4000`/`4100`                   | HTTP API under `/api`, auth/ownership, validation, transactional scheduling/outbox dispatch, publication reads, quotes, corrections, and deletion requests         |
| Worker     | `pnpm --filter @book/api dev:worker`, or embedded when `ENABLE_GENERATION_WORKER=true` | none                                       | BullMQ consumption, fenced run claims/heartbeats, deterministic or configured provider execution, run-scoped artifacts, PDF publication, cancellation and recovery |
| Web        | `pnpm --filter @book/web dev`                                                          | normal/E2E `3000`/`3100`                   | Next.js UI, JWT client/session refresh, owned-book workflows, polling/reader/download UX; it does not own credit, estimate, or provider authority                  |

The production-like topology is a separate API and worker with `ENABLE_GENERATION_WORKER=false` on the API. The baseline `.env.example` instead enables an embedded API worker for one-process local convenience. Playwright also uses that embedded-worker topology. MinIO (`9000`, console `9001`) exists in the main Compose file but is not required when both storage drivers are `local`.

## Required services and configuration

Required services are PostgreSQL and Redis. Node.js 20+ and pnpm 9+ are required; the audited machine used Node `v24.11.1`, pnpm `9.4.0`, Docker Engine `29.6.1`, and Docker Compose `v5.1.4`.

Required API values are `DATABASE_URL`, `REDIS_URL`, `JWT_SECRET` (at least 32 characters), and `JWT_REFRESH_SECRET` (at least 32 characters). The complete local mock/home configuration also fixes:

```dotenv
NODE_ENV=development
PORT=4000
ALLOWED_ORIGINS=http://localhost:3000
WEB_APP_URL=http://localhost:3000
AUTH_MODE=jwt
PRODUCT_MODE=home
NEXT_PUBLIC_PRODUCT_MODE=home
STORY_GENERATION_PROVIDER=mock
CHARACTER_PROFILE_PROVIDER=mock
IMAGE_GENERATION_PROVIDER=mock
EMAIL_PROVIDER=console
STRIPE_BILLING_ENABLED=false
PDF_STORAGE_DRIVER=local
IMAGE_STORAGE_DRIVER=local
ENABLE_GENERATION_WORKER=false
```

The web requires `NEXT_PUBLIC_API_URL=http://localhost:4000/api`, `NEXT_PUBLIC_AUTH_MODE=jwt`, and `NEXT_PUBLIC_PRODUCT_MODE=home`. `PRODUCT_MODE` and `NEXT_PUBLIC_PRODUCT_MODE` must match at API startup. No OpenAI credential is required or permitted for the mock setup; an OpenAI provider selection fails startup without `OPENAI_API_KEY`.

Local storage defaults to `apps/api/tmp`: PDFs under `books/<bookId>/...` and images under the image storage namespace. Cloud storage variables are only required for `s3`/`r2` drivers.

## Database and safe fixtures

Apply the checked-in, non-destructive migration history with:

```powershell
$env:DATABASE_URL='postgresql://storyme:storyme_e2e@127.0.0.1:5440/storyme_e2e'
pnpm --filter @book/api prisma:migrate:deploy
```

The baseline Playwright API command, `start:e2e`, runs migrations and `e2e:seed` before starting Nest. The seed is synthetic and guarded: the database name must contain `e2e`, Redis must select a non-zero database, and only users ending in `@e2e.storyme.test` plus their artifacts are removed. No general application seed is required.

## Expected mock-generation flow

An authenticated owner creates a draft, requests the server estimate, and starts generation. In home mode the API creates an immutable input snapshot, a queued `GenerationRun`, the first `Book` workflow status, and a pending outbox event in one transaction without debiting a credit. The dispatcher enqueues a BullMQ job. A worker claims it and advances fenced stages through character/story planning, deterministic mock images, layout, and PDF render/publication. Temporary artifacts are run-scoped; the final transaction changes authoritative publication pointers only for the still-current fenced run. The web polls status while retaining any prior publication and reads/downloads the published PDF through owned API routes.

## Baseline validation evidence and known failures

The following were run against the clean committed baseline:

- `pnpm typecheck`: pass, 4/4 Turbo tasks.
- `pnpm test`: pass; includes API/types/web suites and 6/6 archive tests.
- `pnpm --filter @book/web test`: pass, 29 files and 358 tests. It emits inherited React `act(...)` and jsdom navigation warnings.
- `pnpm --filter @book/api test:integration`: pass, 11 files and 93 tests against the configured local PostgreSQL/Redis.
- `pnpm archive:clean:test`: pass, 6 tests.
- `pnpm --filter @book/api exec prisma validate`: pass.
- `pnpm format:check`: fail on 133 committed files.
- `pnpm lint`: fail immediately with 312 `Delete CR` Prettier errors in committed `packages/types/src/agent.types.ts`.

These formatting/lint failures are proven inherited from `bc0d49d` because they were captured while `git status --short` was empty. A second operational contradiction is also present at baseline: `docker-compose.yml` exposes PostgreSQL at host port `5433`, while `.env.example` points `DATABASE_URL` at `localhost:5432`. Disposable E2E configuration is internally consistent at PostgreSQL `5440`, Redis `6380/15`, API `4100`, and web `3100`.

## Exact baseline commands

Disposable infrastructure and the baseline Playwright topology:

```powershell
docker compose -f docker-compose.e2e.yml up -d --wait
$env:DATABASE_URL='postgresql://storyme:storyme_e2e@127.0.0.1:5440/storyme_e2e'
$env:REDIS_URL='redis://127.0.0.1:6380/15'
pnpm --filter @book/web test:e2e
docker compose -f docker-compose.e2e.yml down
```

For a production-like three-process local launch after migrations, set the variables above and run in separate terminals:

```powershell
pnpm --filter @book/api dev
pnpm --filter @book/api dev:worker
$env:NEXT_PUBLIC_API_URL='http://localhost:4000/api'; pnpm --filter @book/web dev
```

Stop the three foreground processes with Ctrl+C. Clean only disposable E2E fixtures with `pnpm --filter @book/api e2e:cleanup` while the guarded E2E URLs are set; clean local generated artifacts with `pnpm privacy:cleanup-local -- --apply` only after confirming the dry run.
