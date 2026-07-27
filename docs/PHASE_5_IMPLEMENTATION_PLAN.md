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

Implemented behind `STORY_REPAIR_ENABLED=false` by default. A repair-capable story provider
receives an immutable clone of the candidate and typed findings only when every error is marked
repairable. It may run at most once; its complete typed result passes structural validation and
the same deterministic gate exactly once. A provider error or second validation failure ends the
run safely, while non-repairable safety findings never reach the repair provider.

When the OpenAI story provider is selected, the possible repair call is included in the paid-call
plan before a run or credit charge is created. A maximum-size all-OpenAI run therefore needs a
limit of 18 instead of 17 when repair is enabled. Repair telemetry persists only safe metadata
(operation, provider/model, prompt hash, duration, status, and configured estimate), never prompt
or response content.

Polish remains part of the public input contract, while the deterministic mock provider currently
falls back to English content for non-Russian input. Correct Polish mock content is a prerequisite
before language-content heuristics can be made stricter without breaking deterministic tests.
