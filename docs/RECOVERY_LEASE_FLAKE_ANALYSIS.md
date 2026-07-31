# Recovery/lease flake analysis

## Symptom and reproduction

The Phase 8 handoff reported one failed recovery/lease assertion in an
intermediate 93-test run, followed by a narrow pass and later complete passes.
The original Vitest failure output was not retained, so the exact historical
`expect(...)` line cannot be recovered honestly. The timing-sensitive real-DB
assertions in scope are in
`generation-fencing.integration.spec.ts`, under `GenerationRunRecoveryService
— RecoveryLease leadership across two instances`; they assert acquisition,
monotonic generation, and stale-leader rejection.

Before the Phase 8.1 test-isolation change:

- exact expired-lease takeover test: 25/25 passed;
- that file plus `claim-artifact-cleanup-lease.integration.spec.ts`, using the
  default parallel-file runner: 25/25 passed;
- observed reproduction rate: 0/50 targeted invocations.

No arbitrary sleep, timeout increase, Redis timing change, or production lease
change was used.

## Root cause assessment and fix

The production path uses one conditional PostgreSQL `UPDATE`, PostgreSQL
`NOW()` for expiry arithmetic, and a monotonically incremented fencing token.
The test force-expires the row with PostgreSQL server time and awaits every
transition. There is no application-clock boundary or transaction-visibility
gap in that path, and Redis is not involved in lease acquisition.

The concrete residual hazard was shared test state: multiple integration files
mutate the same two singleton `recovery_leases` rows while Vitest may run files
in parallel. One file's `beforeEach`/`afterEach` cleanup can therefore clear a
lease another file is asserting. `vitest.integration.config.ts` now sets
`fileParallelism: false`. Explicit concurrency tests inside a file remain
concurrent and barrier-driven.

The takeover test now also reads the persisted singleton row after leader A's
acquisition, after forced expiry, and after leader B's acquisition. Diagnostic
assertions report whether an owner exists, whether PostgreSQL considers the
lease live, and the persisted fencing generation. These assertions verify
durable lifecycle state rather than elapsed wall time.

This does not weaken the lifecycle contract: production code and lease values
are unchanged. It only prevents unrelated test files from concurrently
resetting a shared singleton and strengthens persisted-state evidence.

## Residual risk

Because the historical failure output is unavailable and 50 pre-fix targeted
runs did not reproduce it, shared singleton cleanup is a strongly supported
test-harness diagnosis, not a proven capture of the original interleaving. A
production race was not found, so no production regression test was warranted.
Post-fix, the corrected expired-lease takeover test passed 25/25 consecutive
runs. The residual risk is therefore limited to the unavailable historical
failure output; the reproducible release gate is green.
