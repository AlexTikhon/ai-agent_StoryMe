# StoryMe pause handoff — 2026-11-05

Development is paused after four additional local commits on `main`, based on
`5d1a7f5`. No push, deployment, paid provider run or scenario publication was
performed. This remains a local mock-provider/private-pilot candidate.

## Previous checkpoint and final slice

The previous commit, `5d1a7f5`, documented the 2026-11-04 architecture review and
freeze. Its preceding three commits stabilized CLI import checks, isolated each
verification invocation's Compose resources and bounded Docker ownership probes.
The historical handoff is preserved in that commit; the earlier seven-step demo
closeout remains in [PROJECT_CLOSEOUT.md](PROJECT_CLOSEOUT.md).

That review identified a concrete outbox risk: malformed/unknown events stayed in
the oldest limited batch forever. A full batch could starve newer authorized work;
a JSON-null payload could also throw before the per-publish error handler. This
slice addresses that risk without changing product endpoints, AI providers,
dependencies, credits or publication rules.

| Commit                       | Change                                                                                                                                                                            |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `5e50c4c`                    | Add due timestamps, quarantine metadata, a matching selection index and conditional status/attempt updates; preserve immediate eligibility of existing events.                    |
| `f39c2e3`                    | Quarantine invalid envelopes and unknown aggregates; contain individual event errors; pass observed attempt versions into bounded exponential backoff.                            |
| `8f4470c`                    | Add PostgreSQL/Redis regressions for full-batch progress, durable quarantine, concurrent attempt updates and terminal-state protection; typecheck both outbox integration suites. |
| Fourth commit, this document | Record final verification, outbox operations, architecture decisions, limitations and restart steps.                                                                              |

See [outbox-operations.md](outbox-operations.md) for dispatch policy, migration
ordering, inspection and reviewed recovery. Quarantine preserves evidence; it does
not automatically repair an aggregate, refund credits or reauthorize paid work.

## Architecture decisions

The review inspected workspace/module composition, shared contracts, Prisma schema,
API/worker entrypoints, generation scheduling/execution/publication/recovery,
artifact coordination, interactive persistence/publication, authentication and web
request/session/polling coordination, plus verification/CI launchers. This is a
focused architecture/source review supported by automated regression evidence,
not a claim that every line received an exhaustive security audit.

- Retain the NestJS modular monolith with explicit API and worker processes.
  Worker reuse of HTTP feature-module composition remains coupling to revisit only
  when deployment/ownership needs justify it; network services would add failure
  modes without helping this slice.
- Preserve the single transaction for run, credit, Book transition and outbox.
  PostgreSQL authority, at-least-once delivery, job identities and worker fencing
  remain complementary. Quarantine/backoff improves selection liveness; it does
  not introduce exactly-once delivery or a transaction with Redis.
- Preserve attempt-scoped artifacts, write intents and candidate/published
  separation. Object storage remains outside DB transactions; stalled writers,
  cleanup and deletion still require their existing fencing/recovery mechanisms.
- Keep runtime provider authorization, finite budgets, cancellation, deterministic
  validation and editorial publication gates. Offline/mock success demonstrates
  pipeline behavior, not real-model quality or cost.
- Keep interactive play deterministic and scenario-version pinned, with row-locked
  transitions and immutable idempotent retries. AI authoring stays outside play.
- Preserve memory-only access tokens, refresh rotation, session epochs, route
  freshness and cancellable polling. Temporary transport failure remains distinct
  from credential rejection. No frontend behavior changed in this slice.

## Fresh local verification

Windows, Node 24.11.1, pnpm 9.4.0, Docker PostgreSQL 16/Redis 7 and Chromium.
Providers were forced to mocks; no paid or production target was used. Logs remain
local under `.git/freeze-20261105-*.log`, outside source control.

| Check                                     | Result and scope                                                                                                                                                                                                                                                          |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Focused outbox unit suites                | PASS: 25 tests.                                                                                                                                                                                                                                                           |
| API `typecheck:integration:hardening`     | PASS, including the two outbox integration suites.                                                                                                                                                                                                                        |
| `pnpm verify:local --profile integration` | PASS: 28 files / 330 tests; all 39 migrations applied to disposable PostgreSQL, including the new outbox migration; owned startup/teardown passed.                                                                                                                        |
| Forced offline profile                    | PASS: `TURBO_FORCE=true pnpm verify:local --profile offline`, no Turbo cache hits. Types 2 / API 2688 / web 842 unit tests; 3 API symlink tests skipped on Windows. Launcher 115, archive 6; offline evals 30 / 29 / 42. Lint, typecheck and API script typecheck passed. |
| Browser profile                           | PASS: `pnpm verify:local --profile browser`, 58 Chromium journeys plus 1 recovery journey, no retries. Fixture cleanup, scoped teardown and server-port release passed.                                                                                                   |
| Production builds and smoke               | PASS: direct `pnpm -r --workspace-concurrency=1 build` in production mode for all three packages, without Turbo; Next build cache retained. Production Chromium smoke 1/1 against `next start`, static landing page only, not an authenticated production-stack test.     |
| Formatting and documentation links        | PASS: repository-wide `pnpm format:check`, 108 local documentation targets/anchors, `git diff --check`.                                                                                                                                                                   |

The initial integration run before the added batch regressions also passed
27 files / 324 tests. The final 330-test run supersedes it for this slice.

The previous Windows Turbo execution block did not reproduce: the forced offline
wrapper passed in this session, without an OS-policy or dependency change.
All invocation-owned Compose resources were removed; pre-existing legacy containers
were left untouched. Ports `5440`, `6380`, `4100`, `3100` and `3200` were free after
verification. No `.env` file was edited.

## Remaining limits

1. **Deployment:** `main.ts` fixes `trust proxy` at one hop. Validate actual ingress
   paths and direct access before exposing the API; client IP controls auth
   throttling. Shared storage, email, secrets, backups and restore still need
   deployment-specific verification. No hosted CI run covers these four local
   commits.
2. **Quarantine operations:** there is no automatic repair or public management
   endpoint. Review aggregate authority before any targeted requeue; an event can
   outlive cancellation, recovery, deletion or its originating deployment version.
   Drain old dispatchers for the upgrade: they ignore retry deadlines and have
   unconditional acknowledgement writes. The migration uses ordinary DDL/index locks.
3. **Paid AI:** real-provider quality, refusal rates, consistency, latency and cost
   remain unmeasured. Resume with an explicitly authorized capped dataset and
   record prompt/model versions, budgets, failures and quality outcomes.
4. **Operational evidence:** a fresh dispatcher instance demonstrates durable DB
   selection, not a killed OS process. Injected queue failures are not a real Redis
   outage. Load, cloud storage and disaster recovery remain unverified end to end.

Keep the earlier limitations on diagnostics provenance, one published interactive
scenario, mock showcase assets and local artifact directories from
[PROJECT_CLOSEOUT.md](PROJECT_CLOSEOUT.md#known-limitations).

## Restart

1. Inspect `git status --short --branch` and `git log 5d1a7f5..HEAD`; there should be
   exactly four local commits in this slice. Install with
   `pnpm install --frozen-lockfile` and regenerate Prisma Client.
2. Read [outbox-operations.md](outbox-operations.md) before migrating an existing
   environment. Apply migrations before new API/worker binaries; never reset an
   unknown database. This closeout migrated disposable databases only.
3. Check Docker and free ports `5440`, `6380`, `4100`, `3100`. Run
   `pnpm verify:local --profile offline`, then `integration`, then `browser`, one
   at a time. Use [local-verification.md](local-verification.md) for prerequisites
   and invocation-scoped cleanup; do not remove unrelated containers.
4. Run the demo with `pnpm demo:local`; open `http://127.0.0.1:3100`. The demo still
   uses the legacy `storyme-integration` name and refuses an existing stack.
5. Choose one remaining limit above for the next bounded task. Push, deployment,
   real-provider evaluation and publication require their own explicit task.
