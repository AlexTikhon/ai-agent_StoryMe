# Interactive scenario authoring (Phase 5)

An offline-first CLI that turns a small fictional **brief** into a **mechanically validated scenario candidate** plus local **review artifacts** for a human editor.

```
fictional brief → scenario candidate → deterministic validation → optional bounded repair → local review artifacts
```

The model proposes content. The existing domain code verifies the declared rules and the playable routes. **A human reviews the prose before anything is published.** The gameplay runtime is untouched: no LLM is connected to `NarratorProvider`, whose exact-template validation is unchanged.

Code lives in `apps/api/src/interactive/authoring/`; the CLI is `apps/api/scripts/author-interactive-scenario.ts`. There is no Nest endpoint, database, worker, queue or editor UI, and it is independent of the children's-book `StoryGenerationProvider`.

## Quick start (mock, no keys, no network)

```bash
pnpm author:interactive --mode mock                    # writes under apps/api/scenario-drafts/
pnpm eval:interactive:authoring:offline                # fixtures only; no services, keys or network
```

Mock mode proposes the bundled original episode **“The Last Tram”** (`warsaw-last-tram` v1): a contemporary Warsaw mystery about a vanished charity cash box. Characters and events are invented. It is **not** registered in the scenario registry and is never served.

Example output:

```text
Mode: mock (offline, deterministic, no network)
Result: REVIEW_REQUIRED (mechanically valid; NOT approved, NOT published)
Candidate: warsaw-last-tram@1 hash=<sha256>
Requests: 1, HTTP attempts: 0
Artifacts: apps/api/scenario-drafts/<run>--review-required
```

Exit codes: `0` review-required candidate written; `1` rejected or stopped run (a failure report is written); `2` usage, configuration or brief error (nothing is written).

## The brief

A bounded JSON object (≤ 8 KB, English/Latin-script text, strict schema, validated locally — see `brief.ts`):

| Field                        | Rule                                                       |
| ---------------------------- | ---------------------------------------------------------- |
| `scenarioId`, `version`      | The candidate identity; kebab-case id, version 1–1000      |
| `premise`, `setting`, `tone` | Short English prose                                        |
| `characters`                 | Exactly 3, exactly one `isPlayer`, each with a description |
| `endings`                    | Exactly 2 ending concepts (id, title, concept)             |

Candidate identity comes from the validated brief. Provider output that changes the id, version, character ids/player flag or ending ids is rejected. A brief whose `(id, version)` is already in the published scenario registry is refused **before any provider call**.

## Authoring format (checked locally, not by prompt)

6–8 scenes · exactly 3 decision points (scenes with ≥ 2 choices) · exactly 2 endings · exactly 3 characters with one player · at most 3 choices per scene · ≤ 16 facts, ≤ 6 items, ≤ 12 flags · an **acyclic** scene graph · ≤ 48 KB canonical size · only the existing requirement/effect vocabulary (`playerKnows`, `hasItem`, `flag`, `notFlag`; `learnFact`, `npcLearns`, `giveItem`, `consumeItem`, `setFlag`).

## Validation pipeline

`validateCandidate` (in `validate.ts`) runs these stages in order; the first failing stage stops the rest:

| Stage                   | What runs                                                                                                                                                                                                                                          | Reused or new                       |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| `candidate-format`      | Size bound, JSON parse, strict wire DTO, normalization into the runtime shape (duplicate map/list entries are **rejected**, never overwritten)                                                                                                     | new (`wire.ts`)                     |
| `identity`              | id/version/characters/endings equal the brief; not already published                                                                                                                                                                               | new                                 |
| `definition`            | `parseScenarioDefinition`: strict schema + structural checks (references, unique ids, entry/terminal scenes, reachability)                                                                                                                         | reused                              |
| `authoring-constraints` | counts above, cycle detection, size                                                                                                                                                                                                                | new — **before** exploration        |
| `play-analysis`         | `analyzeScenario`: reachable states, usable choices, reachable endings, no dead ends, declared speaker knowledge (`MAX_EXPLORED_STATES` unchanged)                                                                                                 | reused                              |
| `witness-routes`        | shortest route to each ending found with `availableChoices`/`applyChoice`; every prefix replayed with `verifyReplay` and checked with `validateNarration` on the canonical narration; canonical narration is also checked in every reachable state | reused engine functions, new search |

Diagnostics are de-duplicated and bounded (≤ 25 items, ≤ 240 characters each).

### What a pass means — and does not mean

A pass means **mechanically valid, requiring editorial review** (`REVIEW_REQUIRED`). It never means “approved” or “safe to publish”.

`factIds` on narration templates are **assertions supplied by the author/model**. The checks prove that, wherever a template is shown, its declared speaker knows the declared facts. They do **not** prove that arbitrary prose contains no unannotated spoiler, contradiction or unsupported statement. This limitation is demonstrated by a test (`review.spec.ts`) and the eval case `adv.review.mechanical-not-approved`: prose that flatly contradicts annotated testimony passes every mechanical stage and is still only `REVIEW_REQUIRED`.

## Generation, repair and call limits

- **One** generation request. If (and only if) deterministic **content** validation fails, **at most one** repair request that receives the bounded previous candidate and the bounded diagnostics. A repaired candidate gets no shortcut: it goes through the whole pipeline again.
- Provider/transport outcomes **stop** the run with a stable reason and never trigger repair: `REFUSAL`, `TRUNCATED`, `AUTHENTICATION`, `RATE_LIMITED`, `TIMEOUT`, `NETWORK`, `CANCELLED`, `PROVIDER_ERROR`, `INVALID_RESPONSE`, `DEADLINE_EXCEEDED`, `CALL_BUDGET_EXCEEDED`.
- Total budget: ≤ 2 requests and ≤ 2 provider HTTP attempts. The OpenAI adapter calls the shared `fetchWithRetry` with `maxRetries: 0` and `timeoutMaxRetries: 0`, so transport retries cannot multiply the budget; a request that reports more attempts than allowed stops the run.
- Bounded: brief (8 KB), candidate text (60 000 chars), HTTP body (200 000 chars), output tokens per request, per-request timeout, overall deadline, diagnostics.
- The model gets no tools, browsing, filesystem or code execution. The brief is passed as delimited data.
- Provenance records actual request attempts, **provider-reported** token usage (omitted when not reported), durations, prompt/schema versions and the candidate hash. **No monetary cost is estimated.**
- Never logged or written: credentials, the full brief, raw provider error bodies, rejected model output (only its SHA-256).

## Provider configuration

| Setting                                         | Mock                              | OpenAI                                                   |
| ----------------------------------------------- | --------------------------------- | -------------------------------------------------------- |
| `--mode mock\|openai`                           | required                          | required                                                 |
| `--allow-paid-calls`                            | rejected                          | **required** (an API key alone never enables paid calls) |
| `--model` / `INTERACTIVE_AUTHORING_MODEL`       | n/a                               | **required**; there is no default model                  |
| `OPENAI_API_KEY`                                | unused                            | required                                                 |
| `--brief the-last-tram` / `--brief-file`        | default built-in brief            | one is required explicitly                               |
| `--max-output-tokens` (`…_MAX_OUTPUT_TOKENS`)   | default 8000, range 1000–16000    | same                                                     |
| `--request-timeout-ms` (`…_REQUEST_TIMEOUT_MS`) | default 120000, range 5000–300000 | same                                                     |
| `--deadline-ms` (`…_DEADLINE_MS`)               | default 300000, range 5000–600000 | same                                                     |

Out-of-range values are rejected, not clamped. The OpenAI adapter is configured independently of the book pipeline (it does not read `OPENAI_REQUEST_TIMEOUT_MS`, `OPENAI_MAX_RETRIES` or any book model setting) and uses Chat Completions Structured Outputs with a dedicated, strict, hand-written schema (`wire.ts`): every property required, `additionalProperties: false`, optional values as required-nullable fields, flat `{kind, ref}` requirements/effects instead of unions, and NPC knowledge as an array of entries. See <https://developers.openai.com/api/docs/guides/structured-outputs>. Local strict validation remains authoritative.

### Operator command for the paid mode

Not run during implementation. Run it only when you intend to spend money:

```bash
OPENAI_API_KEY=… INTERACTIVE_AUTHORING_MODEL=<model-name> \
  pnpm author:interactive --mode openai --allow-paid-calls --brief the-last-tram
```

**Real-model quality is unverified.** The unit and offline tests intercept HTTP and prove request construction, response handling and call limits only. Whether a real model can produce a valid candidate for a given brief — and how often a repair is needed — is unknown until an explicitly authorized smoke test is run.

## Artifacts

Everything is written under one git-ignored directory, `apps/api/scenario-drafts/` (an alternative root via `--drafts-root` must itself be named `scenario-drafts`, must not be a symlink, and must not be inside `src`, `assets`, `dist`, `prisma`, `apps/web` or any `public` directory). Each run gets a fresh directory; existing files are never overwritten. A run is written to `<run>.incomplete/` and renamed only when every file is on disk:

| Directory suffix    | Meaning                                  | Files                                                                    |
| ------------------- | ---------------------------------------- | ------------------------------------------------------------------------ |
| `--review-required` | mechanically valid, awaiting a human     | `validated-candidate.json`, `validation-report.json`, `review-report.md` |
| `--rejected`        | content failed validation (after repair) | `run-report.json` only — **no candidate file**                           |
| `--stopped`         | provider/transport stop                  | `run-report.json` only                                                   |
| `.incomplete`       | crashed or interrupted run — ignore it   | partial                                                                  |

`review-report.md` contains the candidate identity/hash and validation results, reachability summary, witness routes to both endings, character knowledge, fact disclosures, item consumption, branch prerequisites, every authored narration template with its declared speaker/fact annotations, a list of what the validation does **not** prove, and an editorial checklist (unannotated secrets, contradictions, pacing, meaningful choices, audience suitability, originality, endings).

## Review and publication

1. A human reads `review-report.md` and the candidate prose and completes the checklist.
2. Publication is a **separate, explicit, manual step** (adding a new, append-only registry entry in `scenarios/index.ts` with tests and, optionally, a presentation pack). **This tool has no approve or publish command, and nothing it writes is registered, hashed into sessions or served.**

## Offline evaluation

`pnpm eval:interactive:authoring:offline` (also a CI step) runs fixed fixtures through the real pipeline with a scripted provider and an intercepted fetch: the valid original candidate and both ending routes; malformed JSON, unknown fields/effects, duplicate entries; changed or already-published identity; duplicate ids and unresolved references; a cyclic graph (rejected before exhaustive exploration); an unreachable ending, an unusable choice, a reachable dead end and a speaker-knowledge violation; over-long canonical narration; a valid repair and a repair that stays invalid; refusal, truncation, authentication, timeout, network and cancellation without repair; exhausted and exceeded call budgets; disabled implicit HTTP/network/timeout retries; mechanical validity without approval; and identical candidate hashes across repeated mock runs.
