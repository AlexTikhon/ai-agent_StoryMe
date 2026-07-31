# Home Edition v1 release checklist

This checklist qualifies the local, deterministic Home Edition. It is not a
commercial SaaS or public-production readiness claim.

## Required passing gates

- changed-file formatting and changed-file lint;
- typecheck, unit tests, web tests, and API integration tests;
- Prisma schema validation and clean migration application;
- production build with the public API URL fixed at build time;
- Playwright Home suite using disposable PostgreSQL/Redis and mock providers;
- archive safety and no private/generated artifacts;
- `git diff --check`.

The changed-file scripts default to `HEAD`, include modified and untracked
files, preserve rename destinations, exclude generated output directories, and
accept either `$env:CHANGED_FILES_BASE` or `--base <ref>`. The full
`format:check` and `lint` commands remain available for debt transparency.

## Exact PowerShell release commands

```powershell
$env:CHANGED_FILES_BASE = 'bc0d49d693ac79e2fb2bc5f2658399328f77fd87'
git diff --check
pnpm quality:changed:test
pnpm format:changed
pnpm lint:changed
pnpm typecheck
pnpm test
pnpm --filter @book/web test

docker compose -f docker-compose.e2e.yml up -d --wait
$env:DATABASE_URL = 'postgresql://storyme:storyme_e2e@127.0.0.1:5440/storyme_e2e'
$env:REDIS_URL = 'redis://127.0.0.1:6380/15'
pnpm --filter @book/api prisma:migrate:deploy
pnpm --filter @book/api test:integration
pnpm --filter @book/api exec prisma validate
docker compose -f docker-compose.e2e.yml down

pnpm archive:clean:test
$env:NEXT_PUBLIC_API_URL = 'http://localhost:4000/api'
pnpm build
pnpm test:e2e:home

pnpm format:check
pnpm lint
git status --short
git diff --stat
git diff --check
```

Run the corrected lease test 25 times with disposable infrastructure active:

```powershell
$passed = 0
1..25 | ForEach-Object {
  pnpm --filter @book/api exec vitest run --config vitest.integration.config.ts test/integration/generation-fencing.integration.spec.ts -t 'new instance acquires once the lease has expired' --reporter=dot
  if ($LASTEXITCODE -ne 0) { throw "Lease repetition $_ failed" }
  $passed++
}
Write-Output "Lease repetitions passed: $passed/25"
```

## Migration audit

Migration `20260731120500_allow_home_page_image_quotes` replaces the positive
check with `cost_credits >= 0`. Thus zero is allowed, negative values remain
rejected, and all existing positive rows remain valid. Home mode persists zero;
demo mode retains the configured positive constant. Cost is server-owned—the
quote API accepts an expected page version, not a client-supplied cost—and the
database check is the final negative-value backstop.

Rollback means restoring the old positive check. It must not be attempted while
zero-cost rows exist: archive/delete those rows or migrate them to a deliberate
positive value first. Dropping the new constraint alone would weaken safety and
is not a rollback. Existing migrations must not be squashed or rewritten.

## Known non-blocking debt

- repository-wide legacy CRLF/Prettier violations;
- historical Prisma models retained for compatibility;
- legacy enum values;
- no real-provider smoke test in this release candidate;
- no commercial SaaS readiness claim.
