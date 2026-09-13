# Generation hardening and recovery

The generation worker keeps one whole-book controller job, but page-image
revisions and maintenance use the independent `page-image-revision` and
`book-maintenance` queues. All OpenAI image work still shares the same
Redis provider/model quota gate across queues and processes.

Queue waiting and processing time are separate. A confirmed page-image
revision receives `queueExpiresAt`; claiming it establishes an expiring lease
and a fixed `processingDeadlineAt`. Recovery fails work whose queue or
processing deadline expired, requeues missing deliveries when no remote
outcome is ambiguous, and reuses a verified candidate whose key was persisted
with dispatch intent. Fenced terminal writes release the Book's active
revision pointer; charge and refund ledger keys remain idempotent.

Whole-book generation and page-image revision now use the same mandatory
durable execution gateway. Before provider I/O, every attempt records its
delivery token, fencing version, dispatch identity and start time. Completion
adds the attempt duration, provider request ID, usage/cost metrics and the
typed outcome. The closed failure taxonomy persisted across adapters, stages
and workers is `provider_transient_failure`, `refusal`, `invalid_output`, and
`storage_failure`; messages remain diagnostics rather than control flow.

## Migration

Apply migrations before starting the updated API or any worker:

```sh
pnpm migrate:deploy
```

`20260912100000_page_revision_recovery` is additive. It adds page-revision
candidate provenance, authorization, queue/lease/deadline fields, the durable
provider-operation ledger, typed failure reason, and a recovery index. Existing
rows receive one authorized dispatch and no inferred deadline. Recovery treats
old null deadlines conservatively using their existing timestamps. Existing
generation checkpoints, published edition/PDF pointers, provider-operation
ledgers, credit transactions, and published artifacts are not deleted or
rewritten.

Prisma migrations are forward-only in this repository. Rolling application
code back while leaving these nullable/defaulted columns in place is safe, but
dropping the columns is not an automatic rollback: it would discard candidate
recovery and authorization evidence. If schema rollback is unavoidable, stop
all workers first, reconcile every queued/running page revision, take a
database backup, and ship a separately reviewed forward migration.

## Provider quota controls

- `OPENAI_IMAGE_MIN_INTERVAL_MS`: shared dispatch spacing.
- `OPENAI_IMAGE_MAX_CONCURRENCY`: shared in-flight ceiling.
- `OPENAI_IMAGE_CONCURRENCY_LEASE_MS`: crash backstop for a held permit.
- `OPENAI_IMAGE_MAX_WAIT_MS`: bounded, cancellable permit wait.
- `OPENAI_IMAGE_MAX_RETRIES`, `OPENAI_MAX_RETRIES`, and
  `OPENAI_IMAGE_TIMEOUT_MAX_RETRIES`: immutable authorization inputs.
- `PAGE_IMAGE_QUEUE_WAIT_MS`, `PAGE_IMAGE_LEASE_MS`, and
  `PAGE_IMAGE_PROCESSING_DEADLINE_MS`: revision queue/runtime bounds.

Paid calls remain disabled unless a real provider is explicitly configured.
Tests use mock/scripted providers and never require an external paid request.
The OpenAI adapter acceptance test points at a process-local fake HTTP server
and verifies durable accounting without contacting a paid endpoint.
