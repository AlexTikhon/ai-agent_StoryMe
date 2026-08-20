# Phase 10 AI pipeline audit

Audited against the repository state on 2026-08-20, before Phase 10 implementation.

## Visual identity

- `CharacterProfile` already contains the strongest identity contract: versioned `canonicalAppearance`, `characterFingerprint`, `lockedVisualDescription`, `negativeConstraints`, and `consistencyPrompt`.
- The mock story path did not use that contract to build `CharacterCard`. `mock-story-builders.ts` fabricated brown eyes, wavy brown hair, a medium skin-tone placeholder, a bright smile, and a separate hard-coded `visualAnchor`.
- The OpenAI story v1 response schema asked the story model for `characterCard.visualAnchor` and `characterCard.narrativeDescription`. Mapping then added the same fabricated brown/wavy/medium structured appearance values.
- Story and mock illustration-plan builders combined the story-owned `CharacterCard.visualAnchor` with a second consistency block derived from `CharacterProfile`, allowing contradictory identity descriptions in one planned prompt.
- `OpenAIImageGenerationProvider` added both `characterCard.visualAnchor` and `characterCard.narrativeDescription` around an `entry.prompt` that already carried character-profile constraints. Its character-sheet prompt also reconstructed identity from several profile fields instead of using the locked canonical description.
- Repository-wide search found no production renderer, prompt builder, or UI reading `characterCard.appearance` or its `hairColor`, `hairStyle`, `eyeColor`, `skinTone`, or `distinctiveFeatures` children. Runtime validation and persisted/test fixtures still require/contain the shape, so it is legacy compatibility metadata rather than a current generation input.
- Page-image regeneration reuses the persisted `GeneratedImageEntry.prompt` and `CharacterCard`; therefore the planned entry prompt must remain the canonical text source and the provider must not add a second card-owned identity.

## Cancellation

- `GenerationQueueProcessor` creates an `AbortController` and aborts it when heartbeat ownership is lost. `GenerationExecutionContext.signal` carries that signal, and `AgentService` checks it at selected stage boundaries.
- Provider interfaces did not accept execution options, so the signal stopped before character-profile, story/repair, character-sheet, and illustration provider calls.
- `fetchWithRetry` created only a per-attempt timeout controller. It could not abort active fetches or retry backoff from pipeline cancellation and classified every `AbortError` as timeout.
- `OpenAIImageRateLimiter` serialized calls with a healthy `queueTail`, but queued waits, spacing sleeps, Retry-After waits, and active dispatches were not cancellable.
- Broad catches in `CharacterReferenceStage`, `StoryQualityService`, and `ImageGenerationStage` converted cancellation into fallback, `provider_error`, or a normal partial image failure respectively. Character-sheet regeneration and sheet generation catches had the same control-flow risk.
- `Promise.all` in `ImageGenerationStage` is compatible with cancellation only after queued provider work receives the shared signal and cancellation is rethrown rather than counted.
- Database fencing (`fencingVersion`, delivery token, heartbeat ownership, fenced writes, and transactional publication) is already the final correctness authority and must remain unchanged.

## Timing

- Character, image, layout, and PDF timing use stage-local start times.
- Quality timing starts immediately before deterministic review and includes the optional bounded repair, which is truthful for the quality phase.
- Story timing is incorrect: `StoryQualityService` subtracts the overall pipeline `generationStartedAt`, so non-resumed story duration includes all preceding character work.

## Evaluation

- Ordinary unit/integration tests cover providers and the deterministic quality gate, but there is no executable cross-case story evaluation report.
- There is no free mock evaluation command and no separately guarded paid evaluation command.
- Existing CI/test/build scripts do not intentionally invoke paid evaluation; Phase 10 must preserve that property.
