# Phase 12 durable workflow verification audit

Audited against the clean repository state on 2026-08-21 before Phase 12
implementation.

## Integration gap

The repository already had eleven Vitest integration files and a disposable
Docker Compose stack with PostgreSQL on `5440` and Redis on `6380`. The suite,
however, documented the main development database on `5433`, did not prepare
the Prisma schema, did not own readiness checks, and did not guard against a
developer database URL. The API package had no `.env`, so a plain
`pnpm --filter @book/api test:integration` waited for unavailable PostgreSQL
and reported database-backed tests as skipped. The current machine also had a
stopped Docker Desktop Linux engine, which reproduced that symptom.

Phase 12 reuses the existing disposable E2E services. The integration runner
pins the two isolated URLs, removes paid-provider credentials, checks both
ports, deploys migrations, and only then starts Vitest. Compose health checks
remain the authoritative service-readiness gate for `test:infra:up`.

## Existing durable coverage

- Real PostgreSQL tests already exercise claim/delivery-token fencing,
  heartbeats, stale writes, concurrent terminal transitions, cancellation
  races, publication pointers, previous-publication preservation, credit
  charge/refund atomicity, and recovery leadership.
- A real Redis + PostgreSQL test already forces BullMQ stalled redelivery and
  proves that the new delivery token increments `fencingVersion`.
- Unit tests cover outbox dispatch retry, queue-processor duplicate/no-op
  behavior, resume/copy-forward validation, image cancellation as exceptional
  control flow, bounded story repair, provider budgets, and safe telemetry.
- Phase 11 separated orchestration, provider metrics, image aggregation, and
  publication while retaining coordinator-owned terminal transactions.

## Phase 12 gaps selected for implementation

- deterministic, test-only scripted story/character/image providers;
- workflow tests for 429/network retry, permanent safe failure, cancellation,
  provider-call budgets, and resume/reuse call suppression;
- stronger outbox/duplicate-delivery scenario assertions at real persistence
  boundaries;
- a compact failure matrix and one repeatable local command path.

No new workflow engine or testing framework is needed.
