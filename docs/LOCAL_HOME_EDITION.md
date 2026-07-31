# Local Home Edition

## Prerequisites

Install Node.js 20+, pnpm 9+, and Docker Desktop/Engine with Compose. Ports `5440`, `6380`, `4100`, and `3100` must be free for the disposable stack. No OpenAI key is needed.

## One-command disposable test

```powershell
pnpm install
pnpm test:e2e:home
```

This checks Docker, starts tmpfs-backed PostgreSQL and Redis, waits for health, applies migrations, seeds guarded synthetic fixtures, starts the API with an embedded BullMQ worker and local/mock/home configuration, starts Next.js, runs Playwright, cleans fixtures, and shuts the disposable containers down even after failure.

Manual infrastructure controls are `pnpm local:home:up` and `pnpm local:home:down`. The disposable URLs are PostgreSQL `postgresql://storyme:storyme_e2e@127.0.0.1:5440/storyme_e2e` and Redis `redis://127.0.0.1:6380/15`.

For a production-like local topology, copy the relevant values from `.env.example`, point PostgreSQL at the main Compose host port `5433`, set `ENABLE_GENERATION_WORKER=false`, run migrations, then start API, worker, and web separately:

```powershell
docker compose up -d postgres redis
$env:DATABASE_URL='postgresql://storyme:storyme_dev@127.0.0.1:5433/storyme'
pnpm migrate:deploy
pnpm --filter @book/api dev
pnpm --filter @book/api dev:worker
$env:NEXT_PUBLIC_API_URL='http://localhost:4000/api'; pnpm --filter @book/web dev
```

Use Ctrl+C for the three processes and `docker compose stop postgres redis` for services. First run `pnpm privacy:cleanup-local` as a dry run; add `-- --apply` only to remove `apps/api/tmp` deliberately.

## Synthetic demo fixtures

`pnpm --filter @book/api e2e:seed` creates only marked `@e2e.storyme.test` users/books: one synthetic profile, deterministic English/Russian/Polish requests, and publication/failure scenarios. It refuses a database whose name lacks `e2e` or Redis database zero. `e2e:cleanup` removes that scope. Generated binaries are never committed.

## Failure injection

With mock providers only, set `MOCK_FAILURES_ENABLED=true` in a development/test process, then optionally `MOCK_FAILURE_STAGE=story|character|image`, `MOCK_FAILURE_PAGE=N`, and `MOCK_STAGE_DELAY_MS=0..60000`. It is disabled by default and production startup rejects activation. Never combine failure testing with real providers.
