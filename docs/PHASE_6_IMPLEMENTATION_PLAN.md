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

Define configurable retention, then implement an owned, auditable, idempotent
hard-delete workflow that fences active work and reports retriable storage
failures without destructive startup cleanup.
