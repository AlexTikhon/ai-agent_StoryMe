# StoryMe pause handoff — 2026-11-04

Development is paused after four local commits on `main`, based on merge `dc823f8`.
No push, deployment, paid provider run or scenario publication was performed.
This is a local mock-provider candidate; production readiness remains unverified.

## What the last merge delivered

`dc823f8` merged the seven-step `closeout/demo-local` work: disposable local demo,
profiled verification, browser failure/retry/cancellation journey, dashboard navigation
and accessibility, reproducible showcase capture, generation case study and closeout record.
The original results remain in [PROJECT_CLOSEOUT.md](PROJECT_CLOSEOUT.md).

This final slice makes the verification workflow more reproducible without changing
product contracts, providers, database schema or dependencies:

| Commit                       | Change                                                                                                                                                                                 |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `da8a022`                    | Give the two CLI import-safety checks the sibling test's 30-second allowance; all side-effect assertions remain.                                                                       |
| `9d6cc92`                    | Allocate a random Compose project per verifier; validate and propagate its name through startup and teardown; preserve the legacy default for standalone infrastructure/demo commands. |
| `d232c32`                    | Replace the blocking Docker ownership query with an asynchronous, bounded query; exercise a real hung child and event-loop responsiveness.                                             |
| Fourth commit, this document | Record architecture decisions, verification, limitations and restart instructions.                                                                                                     |

## Architecture review and decisions

The review followed the API/web composition roots, shared contracts, Prisma model and
critical execution paths, then exercised the automated suites. This is a focused source
review and local validation, not an exhaustive security audit of every line.

| Boundary                | Code inspected and decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| API and worker          | [AppModule](../apps/api/src/app.module.ts), [WorkerModule](../apps/api/src/worker.module.ts), [BooksModule](../apps/api/src/books/books.module.ts), [ProviderExecutionModule](../apps/api/src/provider-execution/provider-execution.module.ts): retain the modular monolith and explicit worker process. Shared composition is practical at this scale; importing HTTP feature modules into the worker remains coupling, not a reason to introduce network services.                                              |
| Durable generation      | [Scheduling](../apps/api/src/books/book-generation.service.ts), [outbox](../apps/api/src/outbox/outbox-dispatcher.service.ts), [claim/fence](../apps/api/src/agent/generation-run.service.ts), [execution](../apps/api/src/agent/generation-execution.service.ts), [terminal coordinator](../apps/api/src/agent/generation-run-coordinator.service.ts): preserve run, credit and outbox transaction boundaries. Queue delivery is at least once; fencing and transactional terminal writes protect durable state. |
| Publication and storage | [Publication](../apps/api/src/agent/generation-publication.service.ts), [artifact-write coordinator](../apps/api/src/storage/book-artifact-write-coordinator.ts), [owned asset reads](../apps/api/src/books/book-asset.service.ts), [hard deletion](../apps/api/src/books/book-hard-deletion.service.ts): preserve attempt namespaces, write intents and published/candidate separation. Object storage and PostgreSQL do not share a transaction; leases and cleanup remain necessary.                           |
| AI execution            | [Transport](../apps/api/src/common/openai-request.ts), [failure taxonomy](../apps/api/src/common/provider-execution.ts), generation authorization and [authoring limits](../apps/api/src/interactive/authoring/limits.ts): preserve cancellation, dispatch authorization, finite budgets, structured validation and human review. Mock success measures pipeline behavior, not model quality.                                                                                                                     |
| Interactive product     | [Pure engine](../apps/api/src/interactive/domain/engine.ts), [persistence](../apps/api/src/interactive/interactive.service.ts), [publication guard](../apps/api/src/interactive/publication/guarded-registry.ts): retain deterministic play, version pinning, immutable idempotent retries and row-locked revision transitions. Keep LLM authoring outside the reader.                                                                                                                                            |
| Web and identity        | [Auth service](../apps/api/src/auth/auth.service.ts), [web auth](../apps/web/src/lib/auth/auth-context.tsx), [API client](../apps/web/src/lib/api/client.ts), [book polling](../apps/web/src/app/dashboard/books/%5Bid%5D/use-book-detail.ts), dashboard layout: retain memory-only access tokens, rotating refresh cookies, session epochs, route freshness and cancellable polling. Temporary transport failure must remain distinct from credential rejection.                                                 |
| Operations              | Test launchers, CI workflow, health checks, rate limiting, recovery and metrics: keep exact disposable target checks and owned cleanup. Fresh Compose names avoid stale-container conflicts, but fixed ports still require sequential runs.                                                                                                                                                                                                                                                                       |

## Verification on this machine

Environment: Windows, Node 24.11.1, pnpm 9.4.0, local Docker PostgreSQL 16/Redis 7,
Chromium. Providers were pinned to mocks; no production target or paid credential was used.
Logs are local under `.git/closeout-*.log`, excluded from source control.

| Check                                                                     | Result and scope                                                                                                                                                                                                                                     |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Focused CLI suites                                                        | PASS: 3 files, 60 tests.                                                                                                                                                                                                                             |
| `pnpm test:launcher`                                                      | PASS: 115 tests, including scoped project propagation, refusal before spawn and a real hung-child timeout.                                                                                                                                           |
| `pnpm verify:local --profile integration`                                 | PASS: 27 files, 324 tests, all 38 migrations applied to disposable PostgreSQL; startup and teardown passed. This run started at `9d6cc92`, before the asynchronous probe change; the later browser profile exercises that shared probe at `d232c32`. |
| `pnpm verify:local --profile browser`                                     | PASS at `d232c32`: 58 Chromium journeys plus 1 recovery journey; no retries. Fixture cleanup, scoped teardown and server-port release passed.                                                                                                        |
| `pnpm -r --workspace-concurrency=1 lint`                                  | PASS: all three workspace packages, no Turbo/cache.                                                                                                                                                                                                  |
| `pnpm -r --workspace-concurrency=1 typecheck` and API `typecheck:scripts` | PASS.                                                                                                                                                                                                                                                |
| `pnpm -r --workspace-concurrency=1 test`                                  | PASS: types 2, API 2674, web 842; 3 API symlink checks skipped because file symlinks were unavailable on this Windows host.                                                                                                                          |
| `pnpm archive:clean:test`                                                 | PASS: 6 tests.                                                                                                                                                                                                                                       |
| Story / interactive / authoring offline evals                             | PASS: 30 / 29 / 42 cases; no external API calls.                                                                                                                                                                                                     |
| `pnpm -r --workspace-concurrency=1 build`                                 | PASS: all three packages in production mode, direct pnpm execution without Turbo. Next.js's own build cache was retained.                                                                                                                            |
| `pnpm --filter @book/web test:e2e:production`                             | PASS: 1 Chromium smoke test against `next start`; static landing page only, not an authenticated production-stack test.                                                                                                                              |

Repository-wide `pnpm format:check`, 82 local documentation link targets and
`git diff --check` also passed.

Both invocation-owned Compose stacks were removed. The two pre-existing stopped
`storyme-integration` containers were left untouched. Ports `5440`, `6380`, `4100`,
`3100` and `3200` were free after verification. No `.env` file was edited.

The fresh `TURBO_FORCE=true pnpm verify:local --profile offline` attempt failed at
`pnpm lint`: Windows Application Control refused to execute the installed `turbo.exe`
(`spawnSync ... UNKNOWN`; direct execution confirmed the policy block). No offline profile
success is claimed. The same package checks were run directly through pnpm, with
`verifyEnvironments().checks`, without changing the OS policy or the installed binary.

The first format check found 79 old working-tree files with CRLF or mixed endings.
They were normalized to LF only after verifying that the normalized bytes exactly matched
`HEAD`; migrations were excluded. No content changes from that repair enter the four commits.
The final repository-wide format check passed.

## Remaining limits and resume priorities

1. **Verification environment:** restore an approved Turbo installation or run the offline
   profile on an environment where it is permitted. Direct checks do not establish wrapper
   success. Hosted CI has not been run for these four local commits.
2. **Deployment boundary:** [main.ts](../apps/api/src/main.ts) fixes `trust proxy` at one hop.
   Validate that assumption against the actual ingress and direct-access policy before exposing
   the API; the correct client IP affects authentication throttling. Shared object storage,
   email delivery, secrets, backups and restore still need deployment-specific verification.
3. **Outbox poison records:** [findPending](../apps/api/src/outbox/outbox.service.ts) reads the
   oldest limited batch; the dispatcher logs malformed/unknown events but leaves them pending.
   Inference from code: a full batch of such records could starve newer work. A future slice
   should add quarantine/backoff and a real PostgreSQL regression for batch exhaustion; no
   corruption was observed or injected in this closeout.
4. **Paid AI evaluation:** real-provider quality, refusal rates, consistency, latency and cost
   remain unmeasured. Start with an explicitly authorized capped dataset and record model,
   prompt version, budget, quality outcomes and failed attempts before expanding usage.
5. **Operational evidence:** actual worker termination, Redis loss, database outage, load,
   cloud storage and disaster recovery have not been demonstrated end to end here. Existing
   fault-injection tests provide narrower evidence.

Keep the earlier limitations on diagnostics provenance, one published interactive scenario,
mock showcase assets and empty local artifact directories from
[PROJECT_CLOSEOUT.md](PROJECT_CLOSEOUT.md#known-limitations). The four commits add no new
scenario, external service or product phase.

## Restart

1. Inspect `git status --short --branch` and the four commits after `dc823f8`. Install with
   `pnpm install --frozen-lockfile`; keep real credentials out of verification.
2. Check Docker and free ports `5440`, `6380`, `4100`, `3100`. Do not remove unrelated stacks.
   The verifier can coexist with stopped legacy containers, but the local demo still uses
   `storyme-integration` and refuses an existing stack.
3. Run `pnpm verify:local --profile offline`, then `integration`, then `browser`, one at a time.
   Use [local-verification.md](local-verification.md) for prerequisites and scoped cleanup after
   a crash. A 15-second ownership-probe timeout is an unavailable prerequisite, not a pass.
4. For the demo, use `pnpm demo:local`; open `http://127.0.0.1:3100`. Capture with
   `pnpm demo:capture` only while that owned demo runs.
5. Choose one deferred priority above before resuming implementation. Push, deployment,
   provider evaluation and publication require their own explicit task.
