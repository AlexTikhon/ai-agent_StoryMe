# Phase 13 book-quality audit

Audited against the repository state on 2026-08-22 before Phase 13 implementation.

## 1. What determines story quality today?

- The selected story provider supplies the title, theme, lesson, opening hook,
  resolution, page narration, scene descriptions, and illustration descriptions.
- `buildStoryGenerationPrompt` supplies age, language, theme, optional lesson,
  page count, safety, page-length, continuity, and output-shape instructions.
- Provider response schemas and `validateStoryGenerationResult` enforce the
  cross-artifact page/image shape before the deterministic quality gate runs.
- `evaluateStoryQuality` checks metadata alignment, cover/name alignment,
  lesson equality, preview/plan agreement, page length, exact duplicate pages,
  and unsafe markup/control characters. An explicitly enabled provider may make
  one bounded repair and the same deterministic gate is then run again.
- The mock provider uses localized deterministic templates. OpenAI story
  generation currently uses `gpt-4o-mini` by default with temperature `0.7`.

## 2. What determines image consistency today?

- The character-profile provider creates prose fields for face, hair, eyes,
  outfit, age, and illustration style. `finalizeCharacterProfile` canonicalizes
  those fields, creates an appearance fingerprint, and adds a locked visual
  description plus negative constraints.
- The same profile feeds the character sheet and story/image-plan construction.
  Every cover, page, and back-cover entry receives a character consistency
  block. OpenAI then wraps each entry in either a text-to-image prompt or a
  reference-image edit prompt.
- When a valid claim-scoped character sheet is available, it is supplied to all
  page image requests. Missing bytes fall back to text-only image generation.
  Resume logic decides whether a stored sheet/image can be reused.
- Consistency is encouraged by prompt/reference propagation; generated pixels
  are not evaluated by another model, which correctly avoids an extra paid call.

## 3. Which checks are deterministic?

- Input DTO ranges and lengths, normalized page count, provider response shape,
  contiguous story/preview/image page numbers, exact image-plan cardinality,
  unique image IDs, required prompt safety fragments, metadata equality,
  exact duplicate narration, word limits, plan/preview equality, unsafe markup,
  artifact byte existence, claim ownership, layout construction, and PDF image
  resolution are deterministic.
- Character appearance canonicalization/fingerprinting and artifact reuse,
  cancellation, fencing, publication, and provider-call budgets are also local
  deterministic behavior.

## 4. Which checks depend on an AI provider?

- Story prose, narrative arc, natural personalization, age-appropriate wording,
  scene descriptions, and the initial character description depend on the text
  provider when OpenAI mode is selected.
- Illustration quality and actual visual continuity depend on the image
  provider. A character reference improves that result but is not a pixel-level
  guarantee.
- The optional repair is a second story-provider call. Paid evaluation uses the
  story provider only when both the paid command and `RUN_PAID_AI_EVALS=true`
  are explicitly selected.

## 5. What personalization reaches prompts?

- Story input contains book ID, child name, child age, theme, language, page
  count, optional educational message, and the generated character profile.
- Character-profile input contains child name, age, theme, language, and an
  optional integrity-verified photo. The photo is used only for the profile
  description call; generated page images receive the stylized character sheet,
  never the original child photo.
- The product currently has no separate interest list or supporting-character
  questionnaire. Theme and optional lesson are the only non-visual preference
  inputs beyond the child's name, age, language, and optional photo.

## 6. What is duplicated or inconsistently represented?

- Stable identity appears as individual profile fields, `canonicalAppearance`,
  `consistencyPrompt`, `lockedVisualDescription`, negative constraints, the
  character-card `visualAnchor`, illustration `consistencyNotes`, and complete
  free-form image entry prompts. These are related but not one explicit visual
  bible contract.
- Page scene data appears in `sceneDescription`, `illustrationPrompt`, the
  resolved illustration prompt, preview illustration prompt, and generated
  image entry prompt.
- Prompt versions live as unrelated provider properties. Story repair derives a
  version by string concatenation, while character-sheet and page-image calls
  share one image-provider version despite having different prompt contracts.
- Structural validity is split between the throwing result validator and the
  issue-based quality report, so one report cannot describe every deterministic
  book-quality dimension.

## 7. What valid but mediocre books can pass today?

- The child can appear once and then disappear, another character can take over,
  or a near-variant of the child's name can become the protagonist.
- Pages can be near-duplicates, repeat the same sentence/opening/closing phrase,
  or progress weakly despite not being byte-for-byte duplicates.
- A syntactically non-empty `resolution` and final page can still end abruptly or
  fail to resolve the stated challenge. Theme metadata can match while the prose
  barely represents the selected theme.
- Name-only personalization passes even when age, lesson, and theme have little
  influence on the reading experience. The current gate requires exact lesson
  metadata equality but does not check natural lesson coverage.
- Prompt construction can drift because stable identity and variable scene
  details are repeatedly concatenated as free-form strings.
- The layout engine can create text-only entries when planned images are absent;
  those entries have no image block, so the PDF image resolver does not reject
  them. Null/undefined-like rendered strings and exact cover/back-cover/order
  requirements are not checked as one book-level contract.

## 8. What can improve without more paid calls?

- Add a small pass/fail dimension contract and conservative deterministic checks
  for protagonist coverage, personalization coverage, near-duplicate pages,
  repeated sentences/openings/closings, progression evidence, and ending quality.
- Give the one repair call specific safe issue directives and only the candidate,
  quality contract, and bounded personalization context it needs.
- Introduce one immutable visual-bible projection and one focused image-prompt
  builder that separates stable identity/style rules from variable scene data.
- Register source-controlled prompt versions and assert prompt semantics/hygiene.
- Validate the structured layout before rendering and add a synthetic offline
  corpus containing both passing and deliberately malformed stories.
- Extend existing diagnostics and the opt-in paid evaluator with quality
  dimensions, prompt versions, calls/attempts/tokens/cost/latency, and compact
  baseline-versus-candidate JSON/Markdown comparison.

These changes sit inside the existing successful workflow. They require no new
provider, queue, orchestration layer, persistence authority, or normal-path AI
call.
