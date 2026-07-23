# Phase 2 Implementation Plan

## Dependency map

`BooksController` depends on the public `BooksService` contract. BullMQ's
`GenerationQueueProcessor` also calls `BooksService.runGenerationPipeline` and
`markRunPermanentlyFailedAfterExhaustedRetries`. The split must therefore retain a small
compatibility facade while moving implementation into:

- `BookCrudService`: owned Book lookup, create/list/read/update/soft-delete and editable-state CAS;
- `BookAssetService`: processed child-photo persistence and authenticated published-PDF access;
- `BookGenerationService`: limits, immutable snapshots, transactional scheduling, cancellation,
  worker execution and retry-exhaustion finalization;
- `BookDiagnosticsService`: AgentLog/run/queue/storage reads and DTO assembly.

`AgentService` is called only by the worker-facing generation service. Its durable writes already
cross two explicit boundaries: `GenerationExecutionService.applyFencedBookWrite` for intermediate
Book state, and `GenerationRunCoordinator` for terminal publication. Extraction will preserve
those boundaries and introduce typed stage collaborators for character construction, story
content, image assets, layout, and PDF publication. The orchestrator alone owns ordering,
supersession checks, telemetry aggregation and `GenerationOutcome` assembly.

The book-detail route owns polling and product actions in `use-book-detail.ts`; the presentational
component mixes those controls with a self-contained diagnostics panel. That panel can move to a
separate component without changing props, markup, styles, data fetching, or visibility yet.

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

Runtime tracing proves `GenerationJob` is not used for dispatch, concurrency, fencing, recovery,
charging, cancellation, or publication. Remaining consumers are:

- best-effort mirror writes in `BooksService`;
- a mirror-only startup recovery service;
- tests and historical documentation.

Migration sequence:

1. Completed: diagnostics use the latest authoritative `GenerationRun`, retaining the existing
   `latestJob` response field as a compatibility projection.
2. Completed: stalled-worker detection uses queued/running `GenerationRun`.
3. Remove all mirror writes/providers/recovery code and update tests to assert authoritative run
   behavior instead of best-effort mirroring.
4. Add a migration that drops `generation_jobs`, then its two enums, after pre-migration checks
   confirm no foreign keys or application reads remain.
5. Keep historical documents intact, add a supersession note, and update current documents.

No legacy rows need backfill: every authoritative run already exists in `generation_runs`, and
the mirror was deliberately allowed to be missing or stale.

## Slice order and validation

1. Extract UI diagnostics (lowest risk).
2. Extract Book CRUD/assets/diagnostics behind the facade.
3. Extract Book generation without changing its transaction blocks.
4. Extract typed Agent stages one at a time with focused tests.
5. Replace/remove GenerationJob and apply the schema migration.
6. Run format, lint, typecheck, unit tests, build, then integration tests when local
   PostgreSQL/Redis are available.

Each slice must compile and keep relevant tests green before the next slice.
