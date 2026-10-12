# End-to-end testing

Run the safe complete command from the repository root:

```powershell
pnpm test:e2e:home
```

The runner owns disposable infrastructure cleanup. Playwright itself uses web `3100`, API `4100`, PostgreSQL `5440`, and Redis `6380/15`, JWT auth, home mode, deterministic story/character/image mocks, console email, disabled Stripe, and local storage. Do not set OpenAI provider variables or credentials.

The committed browser suite covers registration, login, refresh-cookie session restoration,
logout/protected-route behavior, reusable child-profile creation/selection and immutable Book
copying without a provider call, server estimate visibility, home-mode generation/PDF download,
cancellation without credits, page-text correction persistence/PDF republication, explicit
page-image quote confirmation and republication, retained publications across
running/failed/cancelled regeneration states, absence of stale publication after initial failure,
and successful retry. Database integration suites additionally cover profile ownership isolation,
soft deletion, Book/run/retry snapshot preservation, atomic publication, page text/image revision
invariants, fencing/redelivery, demo credit debit/refund/idempotency, and hard deletion.

## CI

The CI job **Interactive browser journey** (`interactive-browser` in `.github/workflows/ci.yml`) runs the complete interactive-story suite (catalogue creation, deterministic gameplay, ownership, retries, illustrations, completed-story rereading) on its own runner. Its local equivalent, with the disposable PostgreSQL/Redis already up (`pnpm test:infra:up`), is:

```powershell
pnpm --filter @book/web test:e2e e2e/interactive.spec.ts
```

It exercises the real API and database boundaries with mock providers (no credentials or external services) and development servers (`nest start`, `next dev`) launched by Playwright, which also migrates, seeds and cleans up fixtures. It is distinct from the **Production browser smoke** job, which only checks the built landing page against a production `next build`. On failure the job uploads `apps/web/playwright-report` and `apps/web/test-results` for 3 days; the job always runs `pnpm test:infra:down` last.

To inspect a failure, use `apps/web/test-results` traces/screenshots/videos and the API/worker console correlation fields. Re-run a single test with:

```powershell
pnpm local:home:up
$env:DATABASE_URL='postgresql://storyme:storyme_e2e@127.0.0.1:5440/storyme_e2e'
$env:REDIS_URL='redis://127.0.0.1:6380/15'
pnpm --filter @book/web exec playwright test -g "test name"
pnpm local:home:down
```

Always stop the stack after manual runs. Fixture cleanup is guarded and private data must never be copied into tests.
