# Phase 6: E2E, observability, and retention

Phase 6 is split so browser coverage lands before correlation and destructive
data-lifecycle work.

## Slice 6A — browser E2E foundation

Complete. Playwright runs Chromium against the real Next.js app, Nest API,
BullMQ worker, PostgreSQL, and Redis while every content provider remains in
deterministic mock mode. The first smoke journeys cover:

- registration through the real JWT API;
- login with a disposable verified fixture account;
- book creation and mock generation through the durable queue;
- cancellation of an active run with its compensating credit refund;
- retry of a disposable failed-book fixture through a new durable run;
- authenticated PDF download.

Local E2E services use a separate, ephemeral Docker Compose stack. Fixture
management refuses to reset a database whose name does not contain `e2e` or
Redis database zero. GitHub Actions runs the same browser test with disposable
service containers and retains Playwright traces, screenshots, video, and the
HTML report for failures.

## Slice 6B — request and run correlation

Complete. Every API request now receives a UUID request ID: a valid inbound
`X-Request-ID` is preserved, an invalid or missing value is replaced, and the
chosen ID is exposed in the response header and structured error body. API
request logs contain only the method, query-free path, status, duration, and
allowlisted identifiers.

Generation and page-image-revision commands persist the request ID in the
existing outbox JSON payload and propagate it through BullMQ job data. Outbox,
queue, and worker lifecycle logs can therefore be joined using `requestId`,
`bookId`, and the applicable `runId` or `revisionId`. Legacy outbox events and
jobs without a request ID remain valid; no schema migration is required.

The shared correlation boundary accepts UUID request IDs and restricted
durable identifiers only. Tests prove that prompts, query strings,
authorization headers, malformed IDs, and exception messages cannot enter
these operational logs. Expected stale-run cancellation now bypasses provider
error logging so the execution layer can retain its warning-level semantics.

## Slice 6C — retention and hard-delete

Complete. Retention is explicit configuration:

- `PRIVATE_DATA_RETENTION_DAYS` and `GENERATED_ARTIFACT_RETENTION_DAYS`
  default to 30 days and are snapshotted on each deletion request;
- these values are policy inputs, not an automatic deletion schedule;
- the existing orphan-claim cleanup remains separately disabled and dry-run
  by default. Slice 6C adds no destructive startup or bootstrap pass.

The existing `DELETE /api/books/:id` remains a backward-compatible soft
delete. Permanent deletion requires an authenticated, verified owner to call
`POST /api/books/:id/hard-delete` with `confirmation` exactly equal to the
book UUID. `GET /api/books/deletion-requests/:requestId` returns the
privacy-safe durable state. Repeating the request is idempotent; a
`retry_pending` request is explicitly rescheduled.

### Lifecycle and invariants

The request transaction hides the book immediately, clears its active
pointers, transitions queued/running `GenerationRun` rows to `cancelled`,
transitions queued/running `PageImageRevision` rows to `failed`, increments
both fencing versions, suppresses pending work outbox events, applies the
existing idempotent cancellation/failure refund rules, creates one
`BookDeletionRequest`, and emits a deletion outbox event.

The existing outbox dispatches one deterministic BullMQ deletion job. Queued
generation/revision jobs are removed only when BullMQ says removal is safe;
PostgreSQL fencing remains authoritative. The deletion worker waits while any
older job for the book is active, so a fenced worker must leave BullMQ's
active state before artifact cleanup begins. Since the book is already
soft-deleted and both active pointers are null, stale publication CAS writes
cannot republish it.

Image and PDF drivers delete both legacy and claim-scoped book prefixes.
Local deletion walks only exact validated directories and never follows a
symlink/junction. S3/R2 deletion lists exact prefixes, deletes in provider
batches, and freshly re-lists them. A request is never marked `completed`
while either driver reports a failed list/delete or any remaining object.
Partial success is counted, the private PostgreSQL graph remains intact, and
the next bounded worker attempt retries the remaining scope.

Only after both storage drivers verify empty does one database transaction
remove generation/revision outbox events, remove the book UUID from legacy
series arrays, delete the `Book` (using existing cascades/`SetNull` ledger
semantics), and mark the deletion audit complete.

### Audit and privacy boundary

The surviving audit row contains only the deletion UUID, target book UUID, a
one-way pseudonymous owner hash, actor role, policy snapshot, state, bounded
attempt/artifact counts, bounded error code, and timestamps. It has no FK to
the deleted private graph and never retains email, prompts, story text,
photos, generated JSON, storage keys, provider messages, credentials, or
tokens. Operational logs use the same allowlisted identifiers, counts, and
error codes; raw provider/storage exceptions are not logged by this workflow.

### Migration and recovery

The migration is additive: one enum, one durable table, a unique book index,
and a status/time index. Existing books are not rewritten, and legacy clients
keep the soft-delete behavior. Disabling the new route/worker stops new
destructive work without a schema rollback. Already-deleted rows and objects
cannot be restored by rolling back application code; operators must treat
deployment as an irreversible data operation and rely on backups only where
their own policy permits them.

Deterministic unit and real-PostgreSQL integration tests cover ownership,
exact confirmation, idempotency, both fencing paths, outbox dispatch,
retriable/partial storage failure, storage-empty finalization, stale-work
protection, and the surviving audit privacy boundary.
