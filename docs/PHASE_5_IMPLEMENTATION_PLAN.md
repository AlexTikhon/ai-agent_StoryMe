# Phase 5: Bounded quality and repair

Phase 5 keeps StoryMe's deterministic durable workflow. It does not add autonomous agents,
recursive reflection, or unbounded provider calls.

## Slice 5A — deterministic quality gate

The first slice runs after the typed story result is structurally validated and before any page
image is generated:

`story provider -> structural validation -> deterministic qa_review -> image generation`

The gate produces a versioned, privacy-safe `QualityReport` in the existing
`Book.qualityReport` JSON field. Findings contain stable codes, category, severity, repairability,
and an optional page number; they never contain story text, prompts, or the child's name.

Initial deterministic checks cover:

- requested language/theme/age metadata alignment;
- cover/main-character and requested educational-message alignment;
- story-plan versus preview text and illustration-prompt consistency;
- empty/very short, age-band oversized, and duplicate page narration;
- unsupported control characters, markup, and URLs.

An error fails the run at `qa_review` before image-provider calls. Fenced terminal persistence
keeps a previous publication unchanged. No LLM repair occurs in Slice 5A.

## Slice 5B — one optional typed repair

After Slice 5A is stable, a feature-flagged repair provider may receive the immutable candidate and
typed findings. It may run at most once, must be included in the paid-call plan before generation,
and its result is run through the same deterministic validator exactly once. A second failure ends
the run safely; there is no repair loop.

Polish remains part of the public input contract, while the deterministic mock provider currently
falls back to English content for non-Russian input. Correct Polish mock content is a prerequisite
before language-content heuristics can be made stricter without breaking deterministic tests.
