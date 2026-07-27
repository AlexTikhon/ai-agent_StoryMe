# Phase 6: E2E, observability, and retention

Phase 6 is split so browser coverage lands before correlation and destructive
data-lifecycle work.

## Slice 6A — browser E2E foundation

In progress. Playwright runs Chromium against the real Next.js app, Nest API,
BullMQ worker, PostgreSQL, and Redis while every content provider remains in
deterministic mock mode. The first smoke journeys cover:

- registration through the real JWT API;
- login with a disposable verified fixture account;
- book creation and mock generation through the durable queue;
- authenticated PDF download.

Local E2E services use a separate, ephemeral Docker Compose stack. Fixture
management refuses to reset a database whose name does not contain `e2e` or
Redis database zero. GitHub Actions runs the same browser test with disposable
service containers and retains Playwright traces, screenshots, video, and the
HTML report for failures.

Cancellation and retry browser journeys remain for the next 6A increment.

## Slice 6B — request and run correlation

Add privacy-safe correlation across API, outbox, and worker logs. Correlation
metadata must never contain prompts, story text, photos, passwords, or tokens.

## Slice 6C — retention and hard-delete

Define configurable retention, then implement an owned, auditable, idempotent
hard-delete workflow that fences active work and reports retriable storage
failures without destructive startup cleanup.
