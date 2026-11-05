# Outbox dispatch isolation

The API commits a generation run, its credit charge, the Book transition and its
outbox event together. Page-image revisions and deletion requests also write their
own outbox events transactionally. PostgreSQL remains authoritative; publishing to
BullMQ and acknowledging that publish are separate operations.

## Dispatch policy

`OutboxService.findPending` selects only `pending` events whose `nextAttemptAt` is
due, ordered by that deadline, creation time and ID. A sweep handles at most
`OUTBOX_DISPATCH_BATCH_SIZE` events (default 20) every
`OUTBOX_DISPATCH_INTERVAL_MS` milliseconds (default 2000). One sweep runs per
process at a time; different API/worker processes may still select the same row.

| Outcome                                                                         | Durable result                                                                                                                   |
| ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Supported aggregate and valid dispatch envelope                                 | Publish using the existing aggregate-specific queue/job identity; conditionally acknowledge a still-pending row as `dispatched`. |
| Unknown aggregate                                                               | `quarantined`, reason `unknown_aggregate`.                                                                                       |
| Null, primitive, array, missing/blank book ID, missing/wrong aggregate ID       | `quarantined`, reason `invalid_payload`.                                                                                         |
| Queue publication or acknowledgement failure                                    | Remain `pending`, increment the observed attempt version once, persist `dispatch_failed` and a retry deadline.                   |
| Quarantine/retry persistence fails                                              | Log the event ID, continue the batch; the row remains eligible for a later sweep.                                                |
| Another operation already cancelled, dispatched, quarantined or deleted the row | A stale write changes nothing.                                                                                                   |

Routing continues to use `aggregateType`, not `eventType`. Payload run/revision/
deletion-request identity must equal the row's `aggregateId`. This envelope check
does not replace worker validation of the referenced Book, run, authorization or
fencing version.

Transport delay is `min(300000, 2000 * 2^previousAttempts)` milliseconds. There is
no outbox retry-exhaustion policy: temporary transport errors do not themselves
quarantine authorized work. Existing generation/revision recovery and deletion
policies still apply; a long outage can outlive a run's recovery deadline. Retries
remain at least once. A publish followed by a failed DB acknowledgement can publish
again; queue identity and worker fencing remain necessary.

This policy removes poison rows from subsequent batches and puts failed transport
work behind already-due work. It does not guarantee throughput during a continuing
Redis/database outage or against an unbounded stream of corrupt inserts.

## Observe and inspect

`outbox_quarantined eventId=... reason=...` reports successful quarantine writes.
`storyme_unknown_dispatches_total` retains fixed `aggregate`/`payload` reason
labels. Unknown aggregate strings and corrupt payload values are never copied into
these logs or metric labels. The counter is process-local; query the database for
the durable backlog:

```sql
SELECT status, last_failure_code, count(*) AS events,
       min(created_at) AS oldest_created_at,
       min(next_attempt_at) AS earliest_attempt_at
FROM outbox_events
GROUP BY status, last_failure_code
ORDER BY status, last_failure_code;

SELECT id, aggregate_type, aggregate_id, event_type, attempts,
       quarantined_at, last_failure_code
FROM outbox_events
WHERE status = 'quarantined'
ORDER BY quarantined_at, id
LIMIT 100;
```

These queries omit payloads. Keep any deeper inspection inside the existing
authorized database boundary; payloads must not enter tickets or shared logs.

## Recovery and migration

Quarantine preserves the original row and payload; it does not repair the aggregate,
issue a refund, authorize a paid call or automatically requeue anything. There is no
public quarantine-management endpoint.

For a reviewed repair, identify the producer/schema mismatch first. Check the
referenced generation/revision/deletion request and the Book's current authority:
it may have been cancelled, recovered, superseded or permanently deleted since the
event was created. Never blindly requeue all quarantined rows or create a new run
or charge merely to retry dispatch. A supported, still-authorized event may be
repaired in an explicitly scoped transaction, with a conditional update from
`quarantined` to `pending`, `next_attempt_at = CURRENT_TIMESTAMP`, and cleared
`quarantined_at`/`last_failure_code`. Preserve the attempt history. Recheck dispatch
and the aggregate outcome after that operation.

Migration `20261105090000_outbox_dispatch_isolation` adds three fields and replaces
the pending-selection index. Existing events receive an immediately due timestamp;
no payload or status is rewritten. Drain/stop old API/worker dispatchers, apply
migrations, regenerate Prisma Client, then start the new binaries. Old dispatchers
ignore retry deadlines and use unconditional acknowledgement writes; mixed-version
operation does not provide the new scheduling/status protections. Ordinary
ALTER/CREATE INDEX locking is used: assess table size and maintenance timing for a real deployment.
Rolling back code retains the new columns and quarantined rows; never reset the
database or drop quarantine evidence as a rollback shortcut.

The local regression suite uses disposable PostgreSQL/Redis only. It covers a full
20-event poison batch followed by valid work, transport backoff, concurrent attempt
updates, terminal-state protection and publish-before-ack redelivery. A new
dispatcher instance in a test demonstrates persisted selection; it is not an OS
process-kill or real Redis-outage experiment.
