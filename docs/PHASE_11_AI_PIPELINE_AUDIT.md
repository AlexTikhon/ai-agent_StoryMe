# Phase 11 AI pipeline simplification and observability audit

Audited against the repository state on 2026-08-21 before Phase 11 implementation.

## Pre-change findings

- `AgentService` ordered the workflow but also owned character resume details,
  layout persistence, PDF publication/failure handling, post-generation asset
  classification, resume diagnostics, and terminal outcome assembly.
- It manually constructed `StoryQualityService`, `CharacterReferenceStage`,
  `GenerationResumeService`, `ImageGenerationStage`, `GenerationImageService`,
  and `GenerationResultCollector`.
- Stages wrapped logical calls in `GenerationProviderTelemetry`, but providers
  received only cancellation, so real attempts, waits, and token usage could
  not return through that boundary.
- OpenAI image limiter diagnostics were process-lifetime counters. A run-level
  log and before/after deltas could attribute previous or concurrent work to
  the wrong call.
- Concurrent image tasks mutated shared counters, failure arrays, `lastError`,
  and character-reference flags, making diagnostic order timing-dependent.

## Result

`BooksModule` now composes the preparation, resume, character, story-quality,
image, collector, and publication providers. `AgentService` describes phase
order. `GenerationPublicationService` owns the deterministic publication tail,
while `GenerationRunCoordinator` retains the fenced transactional terminal
transition.

Providers report only optional safe numeric `ProviderCallMetrics` through
`ProviderExecutionOptions.onMetrics`. OpenAI text usage populates provider
usage and existing AgentLog token fields. Common failure kinds distinguish
cancellation, timeout, rate limit, network, authentication, invalid response,
provider error, and unknown without persisting raw provider data.

The image limiter emits per-schedule metrics; separately named global counters
remain operator-only. Image generation and resume classification aggregate
ordered `Promise.all` results after completion.

## Preserved correctness model

GenerationRun authority, fencing version, delivery-token ownership, heartbeat
lease, AbortSignal cancellation, immutable input snapshot/hash, active-run
mirror, claim-scoped artifact ownership, validated reuse/copy-forward,
transactional publication, previous-publication preservation, credit/refund
idempotency, outbox idempotency, and retry semantics are unchanged.
