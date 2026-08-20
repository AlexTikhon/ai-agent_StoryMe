# Phase 9 codebase audit

Audit date: 2026-08-20. This document records findings verified against the current source before Phase 9 implementation changes.

## Confirmed contract drift

- `CharacterProfile` in `@book/types` supports `schemaVersion`, `canonicalAppearance`, `characterFingerprint`, `lockedVisualDescription`, and `negativeConstraints`; `characterProfileSchema` validates none of them. Because Zod object schemas strip unknown keys by default, `toBookDto()` currently removes valid current fields.
- `ImageGenerationResult` supports `generatedImageCount`, `failedImageCount`, `lastImageError`, `characterReferenceAvailable`, `characterReferenceUsedForImages`, `imageGenerationMode`, `characterReferenceLoadError`, `resume`, `imageFailures`, and `providerUsage` in addition to the legacy fields. The runtime schema preserves only `imageByteProvider` and `providerUsage`.
- `GenerationProviderOperation` includes `story_repair`; `generationProviderCallMetadataSchema` does not. One valid repair call therefore makes `providerUsage`, and consequently the complete `imageGenerationResult`, fail parsing.
- The persisted product-data schemas are explicit (not passthrough), which is the correct policy, but they are not tied to the shared types strongly enough for omissions to become compile-time errors.

## Unsafe persisted-JSON boundaries

- `GenerationResumeService.isResumable()` checks only hash equality and non-null JSON fields. It then casts `book.characterProfile` to `CharacterProfile` without validation.
- `AgentService.startBookGeneration()` casts `characterCard`, `storyPlan`, `bookPreview`, and `imageGenerationResult` from Prisma JSON when the resume flag is true. A malformed non-null object can therefore bypass story generation and fail later, or be consumed under a false static type.
- Mapper parsing is safe in the sense that invalid values degrade to `null`, but the incomplete schemas make valid current values degrade or lose fields.
- Artifact ownership is a separate invariant. `resolveLastGenerationNamespace()` deliberately runs before resumability is decided and rejects partial/malformed run/fencing pointers. This must remain a hard failure; malformed reusable product JSON must not weaken it.

## Large-file responsibilities

- `agent.service.ts` (703 lines) resolves immutable input and provider budgeting, prepares resume state, builds/reuses character state, generates/reuses story state, runs quality and bounded repair, generates/reuses images, lays out, publishes PDF, gathers diagnostics, and assembles outcomes. Existing focused stage classes are manually wired in its constructor.
- `story-generation-provider.ts` (942 lines) combines public provider contracts, consistency helpers, deterministic mock character/story/image builders, three languages of chapter/localization templates, and the mock provider class.
- `generation-result.collector.ts` (430 lines) owns deterministic result/diagnostic/outcome assembly. It is large, but cohesive enough that contract and resume correctness have higher priority than splitting it in this pass.
- `generation-diagnostics.ts` (267 lines) defensively projects untrusted JSON with local structural checks. It should consume the corrected runtime contracts where doing so does not change its privacy-safe projection behavior.
- `book-detail-content.tsx` (999 lines) combines top-level state derivation and composition with metadata, generation controls/status/errors, developer-only story/image/layout diagnostics, preview rendering, published reader composition, PDF actions, and empty/loading states.
- `book.types.ts` (715 lines) contains several domains. Its public barrel is stable, but splitting it now would touch many imports while adding less correctness value than fixing schemas and resume validation.
- `agent.service.spec.ts` is substantially larger than its implementation and covers many critical invariants. Coverage must be retained; new parser/stage boundaries should receive focused tests rather than deleting coordinator coverage.

## Invariants that must not change

- Generation input comes exclusively from immutable `GenerationExecutionContext.inputSnapshot` after preparation.
- `GenerationRun` ownership, fencing writes, heartbeat cancellation, `StaleGenerationRunError`, and claim-scoped artifact namespaces remain authoritative.
- A malformed namespace pointer remains a loud invariant failure even if the input hash differs or reusable JSON is invalid.
- Provider telemetry budget, retry behavior, number of planned/actual paid calls, and maximum one story-repair attempt remain unchanged.
- Existing image copy-forward/classification, partial-image-failure behavior, and reference fingerprint compatibility remain unchanged.
- Layout and PDF work remain claim-scoped; final run completion/publication remains an atomic coordinator transaction. Failed regeneration must retain the prior publication.
- Credit charge/refund/idempotency and cancellation compensation remain unchanged.
- API routes, polling, feature-flagged developer diagnostics, page revisions, accessibility semantics, and visible frontend behavior remain unchanged.
- Mock output and OpenAI prompts remain byte-for-byte/semantically unchanged for identical inputs.

## Proposed file changes

- `apps/api/src/books/books.schemas.ts`: add all explicit current fields and simple schema/type conformance checks; export schemas needed at the persisted-state boundary.
- `apps/api/src/books/books.mapper.ts` and `books.mapper.spec.ts`: infer parsed results from typed schemas and add realistic current-generation round-trip/regression fixtures plus malformed cases.
- `apps/api/src/agent/persisted-generation-state.ts` (new): parse the reusable character/story/preview/image JSON as one privacy-safe boundary and report only field/reason labels.
- `apps/api/src/agent/generation-resume.service.ts` and its spec: use typed parsed state, safely disable reuse for malformed product JSON, retain unconditional namespace validation, and expose validated reusable story state to the orchestrator.
- `apps/api/src/agent/agent.service.ts`: consume validated resume state; extract preparation and story/quality responsibilities into small deterministic boundaries, using Nest DI where it reduces manual wiring.
- `apps/api/src/agent/generation-preparation.ts` and `story-quality.service.ts` (new), with focused preparation tests: move immutable preparation and bounded story-quality work behind plain deterministic boundaries without changing the established provider-injection constructor or moving final completion.
- `apps/api/src/agent/story-generation-provider.ts`: retain provider contracts/token and compatibility re-exports; move the mock provider, deterministic builders, and localized templates into `mock-story-generation-provider.ts`, `mock-story-builders.ts`, and `mock-story-templates/*`, with existing output tests retained/split by boundary.
- `apps/web/src/app/dashboard/books/[id]/components/book-detail-content.tsx`: retain the public entry point and top-level composition; move metadata/actions/status, preview/image/layout diagnostics, and PDF UI to `components/book-detail/*` with shared local prop types/helpers only where needed.
- `docs/PHASE_9_PRISMA_DEBT.md`: record current delegate usage and migration prerequisites; no destructive migration.
- `packages/types/src/book.types.ts`: no domain split planned unless implementation reveals a low-churn path; public `@book/types` imports remain stable.
