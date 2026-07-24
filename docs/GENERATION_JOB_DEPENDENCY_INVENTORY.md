# GenerationJob dependency inventory

Status: reviewed source inventory, 2026-07-24. No schema or runtime dependency
has been removed by this document.

This is the removal checklist for the legacy `GenerationJob` mirror. The
authoritative lifecycle is already `GenerationRun`; the remaining table is
best-effort and may be absent or stale without changing dispatch, fencing,
charging, cancellation, publication, API diagnostics, or recovery.

## Runtime reads and writes

All direct Prisma access is centralized in
`apps/api/src/agent/generation-job.service.ts`. No other production source
uses `prisma.generationJob`.

| Operation                                 | Direct runtime consumer                                                        | Purpose today                                                                  | Replacement or proof of non-necessity                                                                                                                                                                                              |
| ----------------------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `findActive(bookId)`                      | `BookGenerationExecutionService.cancelGeneration`                              | Finds a mirror row to mark cancelled after authoritative cancellation commits. | Remove the lookup and mirror update. `GenerationRunCoordinator.cancelGeneration` already atomically cancels the run, updates `Book`, and handles refunds; queue cleanup uses the authoritative run ID returned by the coordinator. |
| `findActive(bookId)`                      | `BookGenerationExecutionService.runGenerationPipeline`                         | Finds a mirror row to mark running/completed/failed.                           | Remove the lookup and all mirror status updates. Claiming and terminal state are owned by `GenerationRunService`/`GenerationRunCoordinator`; `GenerationOutcome` and `AgentLog` persistence do not read the mirror.                |
| `findActive(bookId)`                      | `BookGenerationExecutionService.markRunPermanentlyFailedAfterExhaustedRetries` | Finds a mirror row to copy the authoritative terminal failure into it.         | Remove after `GenerationRunCoordinator.failAbandoned` succeeds. The coordinator transaction is already the durable result.                                                                                                         |
| `findLatest(bookId)`                      | none outside the legacy service/tests                                          | Historical diagnostics read.                                                   | Delete. `BookDiagnosticsService` reads the latest `GenerationRun`, and `buildGenerationDiagnostics` projects that run into the compatibility field `latestJob`.                                                                    |
| `countActiveForUser(userId)`              | none outside the legacy service/tests                                          | Historical concurrency limit.                                                  | Delete. Admission is enforced by the one-active-`GenerationRun` invariant and scheduling transaction; no runtime caller consumes this count.                                                                                       |
| `countCreatedForUserSince(userId, since)` | none outside the legacy service/tests                                          | Historical rolling limit.                                                      | Delete. No runtime caller consumes it. If a rolling product limit is reintroduced, it must query authoritative runs, not revive the mirror.                                                                                        |
| `findStaleActiveJobs(cutoff)`             | `GenerationJobRecoveryService` only                                            | Finds stale mirror rows.                                                       | Delete with the mirror-only recovery service. Authoritative recovery is `GenerationRunRecoveryService`, which checks the run lease and BullMQ state before changing `Book`/run state.                                              |
| `createQueued(...)`                       | `BookGenerationService.createRunAndSchedule`                                   | Best-effort mirror creation after the authoritative transaction commits.       | Remove. The transaction already creates `GenerationRun`, charges credit, updates `Book.activeRunId`, and writes the `run_queued` outbox event. Failure to create this mirror is intentionally swallowed today.                     |
| `markRunning`                             | `BookGenerationExecutionService`                                               | Copies worker start into the mirror.                                           | Remove; `GenerationRunService.claim` owns authoritative running state, lease, and fencing version.                                                                                                                                 |
| `markCompleted`                           | `BookGenerationExecutionService`                                               | Copies a successful terminal state into the mirror.                            | Remove; `GenerationRunCoordinator.completeRun` owns the terminal transaction and publication pointers.                                                                                                                             |
| `markFailed`                              | `BookGenerationExecutionService`, `GenerationJobRecoveryService`               | Copies expected/unexpected/recovery failures into the mirror.                  | Remove; expected and exhausted-retry failures are already applied through the coordinator. Mirror-only startup failure has no product effect and is redundant.                                                                     |
| `markCancelled`                           | `BookGenerationExecutionService`                                               | Copies cancellation into the mirror.                                           | Remove; authoritative cancellation commits first and is sufficient.                                                                                                                                                                |

`BooksService` only receives and forwards `GenerationJobService` to the
extracted scheduling/execution services. It has no independent read or write.
`BooksModule` registers `GenerationJobService` and
`GenerationJobRecoveryService`; both provider registrations become removable
after the consumers above are deleted.

## Recovery compatibility

- `GenerationJobRecoveryService` only changes `generation_jobs`; its own
  contract explicitly forbids changing `Book`. Removing it cannot recover or
  fail an authoritative run.
- `GenerationRunRecoveryService` remains registered in both API and worker
  processes. It uses a Postgres advisory lock, authoritative run leases, and
  BullMQ state.
- `GENERATION_JOB_STALE_AFTER_MS`, its parser/default, startup log messages,
  `.env.example` entry, and mirror-recovery tests become dead configuration
  and must be removed together.
- `GENERATION_RUN_*` recovery/lease settings and operational procedures must
  remain unchanged.

## API and diagnostics compatibility

- No controller, DTO builder, or diagnostics service reads `GenerationJob`.
- `GET /books/:id/generation-diagnostics` obtains the latest
  `GenerationRun`. `buildGenerationDiagnostics` maps it to the existing
  `latestJob: GenerationJobSummary | null` field.
- The public names `latestJob`, `GenerationJobSummary`,
  `GenerationJobType`, and `GenerationJobStatus` are compatibility vocabulary,
  not Prisma-model dependencies. Retain them during table removal unless a
  separately versioned API change is approved.
- `API_SPEC.md` also uses conceptual `GenerationJobDto` names for async API
  contracts. Those names do not prove a database-table dependency and must
  not be removed as part of the Prisma migration.

## Prisma and data dependencies

The destructive schema slice must remove exactly:

- `GenerationJob` from `apps/api/prisma/schema.prisma`;
- `Book.generationJobs`;
- Prisma enums `GenerationJobType` and `GenerationJobStatus`;
- table `generation_jobs`, its two indexes, and its foreign key to `books`;
- the generated Prisma client surface after regeneration.

The historical creation migration
`20260702000000_phase3i_generation_jobs/migration.sql` remains immutable.
Removal requires a new forward migration; the old migration must not be
deleted or edited.

Before reviewing that migration against a real database, capture:

```sql
SELECT status, count(*) FROM generation_jobs GROUP BY status ORDER BY status;
SELECT count(*) AS total_jobs, min(created_at), max(created_at) FROM generation_jobs;

SELECT conname, contype, pg_get_constraintdef(oid)
FROM pg_constraint
WHERE conrelid = 'generation_jobs'::regclass
   OR confrelid = 'generation_jobs'::regclass
ORDER BY conname;

SELECT schemaname, viewname
FROM pg_views
WHERE definition ILIKE '%generation_jobs%';
```

Rows need no backfill: they are a deliberately fallible mirror, diagnostics
already use `GenerationRun`, and no authoritative field is sourced from this
table. The reviewed forward migration should drop the table first and only
then drop `"GenerationJobType"` and `"GenerationJobStatus"`.

## Tests that assume the mirror

These tests must be replaced or removed with their owning runtime code:

- `generation-job.service.spec.ts`: direct CRUD/query tests; delete with the
  service.
- `generation-job-recovery.service.spec.ts`: mirror-only recovery and env
  parser tests; delete with the recovery service.
- `book-generation.service.spec.ts`: mirror creation/successfully-swallowed
  failure expectations; replace with assertions on the authoritative
  transaction/outbox result where coverage is not already present.
- `book-generation-execution.service.spec.ts` and the equivalent facade
  cases in `books.service.spec.ts`: mirror running/completed/failed/cancelled
  expectations and mocks; remove while retaining coordinator, stale-fence,
  cancellation, queue cleanup, and exhausted-retry assertions.
- `generation-credit-charging.integration.spec.ts`: remove the obsolete
  constructor stub/comment only; credit assertions remain authoritative.
- `common/test-utils/mock-prisma.ts`: remove `generationJob` after Prisma
  schema/client removal and after no test references remain.

Tests of `GenerationJobSummary` produced from `GenerationRun` are API
compatibility tests and must remain.

## Operational and historical documents

Current operational references requiring update in the removal slice:

- `.env.example`;
- `docs/CURRENT_PRODUCT.md`;
- `docs/CODEBASE_AUDIT.md`;
- `docs/deployment-readiness.md`;
- `docs/private-demo-deploy.md`;
- current-state and troubleshooting sections of
  `apps/api/docs/local-generation-pipeline.md`.

`docs/PRISMA_MODEL_DECISIONS.md`, `docs/PHASE_2_IMPLEMENTATION_PLAN.md`, and
historical Phase 3I/3J descriptions should retain history but receive a clear
supersession/completion note. Historical descriptions must not be rewritten
as if the table never existed.

## Removal gates

1. Remove runtime mirror creation, reads, status updates, recovery providers,
   env parsing, and their tests.
2. Prove with repository search that only schema/migration/history and public
   compatibility names remain.
3. Run unit tests, lint, typecheck, and production build.
4. Run PostgreSQL + Redis integration suites and exercise generate, retry,
   cancel, recovery, diagnostics, and exhausted BullMQ retry flows.
5. Run the data/constraint/view queries above on the target database and
   review the generated SQL migration.
6. Only then apply the new migration and regenerate Prisma artifacts.

Inventory commands used:

```text
rg "GenerationJob|generationJob|generation_job|generation_jobs"
rg "generationJobService|GenerationJobService|GenerationJobRecoveryService"
rg "model GenerationJob|enum GenerationJob" apps/api/prisma
```
