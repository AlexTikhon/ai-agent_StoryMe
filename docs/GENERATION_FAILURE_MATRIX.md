# Generation workflow failure matrix

This matrix records current behavior verified by deterministic local providers
and real PostgreSQL/Redis boundaries. Provider retries are internal HTTP
attempts inside one logical invocation; they do not consume an additional
logical provider-call budget slot.

| Scenario                                        | Retry                                                                                    | Resume                                 | Terminal state                               | Publication                                               | Credit effect                             |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------- | -------------------------------------- | -------------------------------------------- | --------------------------------------------------------- | ----------------------------------------- |
| Story 429 once                                  | One bounded HTTP retry                                                                   | No                                     | Completed                                    | Current claim once                                        | One charge                                |
| Story network error once                        | One bounded HTTP retry                                                                   | No                                     | Completed                                    | Current claim once                                        | One charge                                |
| Invalid/permanent story response                | No                                                                                       | No                                     | Failed with safe `PROVIDER_INVALID_RESPONSE` | No new publication; prior good pointer survives           | One idempotent failure refund             |
| Worker lock stalls                              | BullMQ redelivers the same job                                                           | Worker B reclaims the run              | Worker B remains authoritative               | Worker A's stale persistence/terminal writes are rejected | Fenced terminal path applies at most once |
| Duplicate queue/outcome delivery                | Existing run/job identity                                                                | Existing run                           | First terminal transaction wins              | Once                                                      | Charge/refund keys remain unique          |
| Story cancellation                              | No                                                                                       | No                                     | Cancelled                                    | None                                                      | One idempotent cancellation refund        |
| Concurrent image cancellation                   | No; all eight calls abort                                                                | No                                     | Cancelled                                    | None; cancellation is not `failedCount++`                 | One idempotent cancellation refund        |
| Cancellation after layout, before PDF           | No                                                                                       | No                                     | Cancelled                                    | Claim images may exist, but no PDF or published pointer   | One idempotent cancellation refund        |
| Completion wins cancellation race               | No                                                                                       | No                                     | Completed                                    | Once                                                      | Charge remains; no cancellation refund    |
| Fully valid retry artifacts                     | No provider calls                                                                        | Copy forward to new claim              | Completed                                    | New claim once                                            | One charge for the new run                |
| One missing retry image                         | Only that image is generated                                                             | Seven images + sheet copied forward    | Completed                                    | New claim once                                            | One charge for the new run                |
| PDF/render/storage failure                      | BullMQ policy handles unexpected infrastructure throws; pipeline PDF failure is terminal | Later run may reuse valid earlier work | Failed                                       | No half-published new version; prior pointer survives     | One idempotent failure refund             |
| Outbox publish succeeds, DB mark is interrupted | Next sweep republishes                                                                   | Same event/run                         | Unchanged until worker executes              | BullMQ `runId` job identity leaves one job                | No business effect at dispatch time       |

## Provider budget example

```text
logical invocation 1: story        -> HTTP attempt 1 succeeds
logical invocation 2: story repair -> HTTP attempt 1 network error
                                  -> HTTP attempt 2 succeeds

logical invocations = 2
HTTP attempts       = 3
logical budget used = 2
```

Normal tests never call an external AI provider. Paid evaluations remain a
separate explicit opt-in behind `RUN_PAID_AI_EVALS=true`; the integration
runner forbids that flag.
