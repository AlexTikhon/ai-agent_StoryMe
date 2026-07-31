# End-to-end testing

Run the safe complete command from the repository root:

```powershell
pnpm test:e2e:home
```

The runner owns disposable infrastructure cleanup. Playwright itself uses web `3100`, API `4100`, PostgreSQL `5440`, and Redis `6380/15`, JWT auth, home mode, deterministic story/character/image mocks, console email, disabled Stripe, and local storage. Do not set OpenAI provider variables or credentials.

The committed browser suite covers registration, login, refresh-cookie session restoration, logout/protected-route behavior, server estimate visibility, home-mode generation/PDF download, cancellation without credits, page-text correction persistence/PDF republication, explicit page-image quote confirmation and republication, retained publications across running/failed/cancelled regeneration states, absence of stale publication after initial failure, and successful retry. Database integration suites cover atomic publication, page text/image revision invariants, fencing/redelivery, demo credit debit/refund/idempotency, and hard deletion.

To inspect a failure, use `apps/web/test-results` traces/screenshots/videos and the API/worker console correlation fields. Re-run a single test with:

```powershell
pnpm local:home:up
$env:DATABASE_URL='postgresql://storyme:storyme_e2e@127.0.0.1:5440/storyme_e2e'
$env:REDIS_URL='redis://127.0.0.1:6380/15'
pnpm --filter @book/web exec playwright test -g "test name"
pnpm local:home:down
```

Always stop the stack after manual runs. Fixture cleanup is guarded and private data must never be copied into tests.
