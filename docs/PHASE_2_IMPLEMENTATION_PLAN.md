# Phase 2 Implementation Record

Status: completed. This document preserves the dependency map, correctness boundaries, migration
sequence, and validation expectations used for the behavior-preserving refactor.

## Dependency map

`BooksController` depends on the public `BooksService` contract. BullMQ's
`GenerationQueueProcessor` also calls `BooksService.runGenerationPipeline` and
`markRunPermanentlyFailedAfterExhaustedRetries`. The completed split retains a small
compatibility facade while moving implementation into:

- `BookCrudService`: owned Book lookup, create/list/read/update/soft-delete and editable-state CAS;
- `BookAssetService`: processed child-photo persistence and authenticated published-PDF access;
- `BookGenerationService`: limits, immutable snapshots, transactional scheduling, cancellation,
  worker execution and retry-exhaustion finalization;
- `BookDiagnosticsService`: AgentLog/run/queue/storage reads and DTO assembly.

`AgentService` is called only by the worker-facing generation service. Its durable writes already
cross two explicit boundaries: `GenerationExecutionService.applyFencedBookWrite` for intermediate
Book state, and `GenerationRunCoordinator` for terminal publication. The extraction preserves
those boundaries and introduces typed stage collaborators for character construction, story
content, image assets, layout, and PDF publication. The orchestrator alone owns ordering,
supersession checks, telemetry aggregation and `GenerationOutcome` assembly.

The book-detail route owns polling and product actions in `use-book-detail.ts`. Runtime
diagnostics now live in `generation-diagnostics-panel.tsx` without changing data fetching or
visibility. The product view still renders intermediate story/layout detail and internal asset
keys; replacing those with reader/image UI and gating diagnostics belongs to Phase 3.

## Transaction and correctness boundaries

These boundaries must not move or be split:

1. Scheduling transaction: create `GenerationRun`, deduct credit, CAS-update Book, create
   `OutboxEvent`.
2. Claim/heartbeat: `GenerationRunService` owns queued/running claims and fencing increments.
3. Intermediate pipeline writes: exact `(runId, fencingVersion)` through
   `GenerationExecutionService`.
4. Terminal success/failure/cancellation: `GenerationRunCoordinator` atomically changes run,
   Book/published pointers, outbox state where applicable, AgentLogs, and refund.
5. Artifact publication: current claim namespace is derived only from execution context; published
   reads resolve only through Book's published namespace pointer.
6. CRUD/photo CAS: edits, deletion and photo pointer updates recheck owned non-deleted Book status
   in the write predicate.

## Legacy GenerationJob migration

Runtime mirror reads/writes, DI providers, and mirror-only startup recovery are removed.
`GenerationJob` is not used for dispatch, concurrency, fencing, recovery, charging,
cancellation, publication, or diagnostics. Its Prisma model/table/enums are removed by the
forward migration; only the immutable historical creation migration, compatibility vocabulary,
and historical documentation remain.

The reviewed read/write/schema/test/operations inventory is maintained in
`docs/GENERATION_JOB_DEPENDENCY_INVENTORY.md`. It is the checklist for the removal and migration
slices below.

Migration sequence:

1. Completed: diagnostics use the latest authoritative `GenerationRun`, retaining the existing
   `latestJob` response field as a compatibility projection.
2. Completed: stalled-worker detection uses queued/running `GenerationRun`.
3. Completed: removed all mirror writes/providers/recovery code and updated tests to assert
   authoritative run behavior instead of best-effort mirroring.
4. Completed: after pre-migration data/dependency checks, added and applied a forward migration
   that drops `generation_jobs`, then its two enums.
5. Completed: kept historical documents intact, added a supersession note, and updated current
   documents.

No legacy rows need backfill: every authoritative run already exists in `generation_runs`, and
the mirror was deliberately allowed to be missing or stale.

## Slice order and validation

1. Completed: extracted UI diagnostics.
2. Completed: extracted Book CRUD/assets/diagnostics behind the facade.
3. Complete: generation admission/atomic scheduling and worker execution/cancellation are
   extracted without changing the authoritative coordinator transaction boundaries.
4. Completed: extracted typed Agent stages one at a time with focused tests.
5. Completed: replaced/removed GenerationJob and applied the schema migration.
6. Repository-wide format, lint, typecheck, unit-test, and build gates remain required before
   release; integration checks remain a separate deployment gate.

Each slice must compile and keep relevant tests green before the next slice.
