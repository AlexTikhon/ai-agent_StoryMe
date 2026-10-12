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
| `--review-required` | mechanically valid, awaiting a human     | `validated-candidate.json`, `validation-report.json`, `review-report.md`, `approval-template.json` (pending) |
| `--rejected`        | content failed validation (after repair) | `run-report.json` only — **no candidate file**                           |
| `--stopped`         | provider/transport stop                  | `run-report.json` only                                                   |
| `.incomplete`       | crashed or interrupted run — ignore it   | partial                                                                  |

`review-report.md` contains the candidate identity/hash and validation results, reachability summary, witness routes to both endings, character knowledge, fact disclosures, item consumption, branch prerequisites, every authored narration template with its declared speaker/fact annotations, a list of what the validation does **not** prove, and an editorial checklist (unannotated secrets, contradictions, pacing, meaningful choices, audience suitability, originality, endings).

## Offline playtest

A reviewer can play a candidate locally before approving it. The playtest drives the production engine (`startSession`, `applyChoice`, `verifyReplay`, canonical narration validation, `buildPublicView`) and reproduces no transition rule of its own. It needs no registration, authentication, PostgreSQL, Redis, Nest or provider, and it only **reads** the candidate file.

```bash
# interactive: numbered choices, q to quit
pnpm playtest:interactive --candidate apps/api/scenario-drafts/<run>--review-required/validated-candidate.json

# scripted: reproducible, same runner and validation
pnpm playtest:interactive --candidate <validated-candidate.json> \
  --choices c-ask-driver,c-leave-cab,c-wait-for-terminus,c-report-to-depot
```

`--candidate` is the normalized runtime artifact (`validated-candidate.json`), not the provider wire format. Every mechanical check is re-run before play, and the canonical candidate hash is printed with the identity. An unpublished or pending candidate may be playtested; approval is not required, mechanical validity is. A local-playtest banner says so on every run.

Each screen shows only the current scene title, the validated canonical narration, the choices available right now, the clues the player knows and the inventory. Locked choices, future scenes, NPC knowledge, internal flags, choice/scene ids and state hashes are never printed. A refused choice reveals only that it is unavailable, never which requirement blocks it. After every accepted choice the event log is replayed against the resulting state. A rejected line changes neither state nor events, and play stops at an ending, which shows its earned title and summary.

| Exit | Result line              | Meaning                                                                                                                                                                            |
| ---- | ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0`  | `PLAYTEST_COMPLETED`     | An ending was reached.                                                                                                                                                             |
| `1`  | `PLAYTEST_FAILED [CODE]` | Candidate unreadable/too large/not JSON/mechanically invalid; scripted choice unknown or locked; choice after an ending; route too long or malformed; input or transcript limit hit. |
| `2`  | (usage text on stderr)   | Missing, duplicated or unknown arguments.                                                                                                                                          |
| `3`  | `PLAYTEST_INCOMPLETE`    | The scripted route stopped, or input reached EOF, before an ending. Never reported as completed.                                                                                   |
| `4`  | `PLAYTEST_CANCELLED`     | `q`/`quit` or Ctrl-C (SIGINT).                                                                                                                                                     |

Bounds: candidate file 200 000 bytes, interactive line 256 bytes, 100 input lines, 32 choices per route (2 048 characters of `--choices`), 200 000 characters of transcript. There is no polling, retry or unbounded loop, and authored text is stripped of terminal control characters before printing.

**This is not review.** Playing every route does not approve the prose, write or change an approval record, register the scenario or publish anything, and there is no web draft-preview endpoint. "The Last Tram" stays `REVIEW_REQUIRED` with a pending approval template. The editorial checklist below still applies in full.

## Exhaustive route review (offline)

The playtest follows one route you choose. An editor also needs the player-visible narration along **every** playable choice sequence, including different paths that reach the same ending.

```bash
pnpm --silent review:interactive:routes --candidate <validated-candidate.json> --format json
pnpm --silent review:interactive:routes --candidate <validated-candidate.json> --format markdown
```

It reads one explicitly supplied `validated-candidate.json`, re-runs the same mechanical validation as the playtest, then walks the production engine (`availableChoices` through the public projection, `applyChoice`, `verifyReplay`, canonical narration validation, `buildPublicView`) and reproduces no transition or narration rule. A pending or unpublished candidate is accepted; approval is neither required nor created. Nothing is written: no database, provider, network, registry or file.

- **Routes are never merged.** Different choice sequences stay separate even when they reach the same state or ending. Order is the engine's depth-first walk in authored choice order, so it is the same for the same candidate hash.
- **Per route:** ordered choice ids and labels, then each scene's title and player-visible narration, and the ending title and summary. Candidate id, version and canonical hash, `REVIEW_REQUIRED`, `approved: false`, `NOT_PUBLISHED`, and route and ending counts head the report. Full state, NPC knowledge, internal flags, template ids and raw events are not included; this is an editorial artifact, not a public API response or a session transcript.
- **Bounds** (a bound that is exceeded fails the run and prints no report, so a partial report is never presented as exhaustive): 100 routes, 32 choices per route, 1 000 explored transitions, 500 000 characters of output, and the 200 000-byte candidate file limit. The authoring format (at most 8 scenes, 3 decision points, 3 choices per scene) stays far below these.
- **Output.** JSON is deterministic and independent of how the candidate file is formatted; characters a terminal may act on (C1 controls, bidi overrides, line separators) are written as `\uXXXX` escapes and the authored text parses back unchanged. Markdown escapes Markdown and HTML syntax so authored text displays literally, quotes every authored line, and replaces terminal control characters with U+FFFD; use the JSON for the exact text.
- **Exit codes:** `0` report printed; `1` unreadable, oversized, non-JSON or mechanically invalid candidate, or a bound exceeded (nothing on stdout, a fixed code on stderr); `2` usage error. As elsewhere, `pnpm` reports any non-zero exit as `1`. Paths resolve from `apps/api` under `pnpm`, so use absolute paths.

**Limits.** Exhaustive route coverage helps a person read every playable path. It does not establish prose quality, detect contradictions or unannotated secrets, approve anything, register anything or publish anything. `warsaw-last-tram` remains unapproved and unregistered, and real-model quality remains unverified.

## Review and publication

1. A human reads `review-report.md` and the candidate prose, optionally playing it with `pnpm playtest:interactive`, and completes the checklist.
2. Publication is a **separate, explicit, manual step**. **This tool has no approve, promote or publish command, and nothing it writes is registered, hashed into sessions, listed in the catalogue or served.**

### Publication boundary (manual sequence)

Each step is a deliberate human action, in this order. Mechanical success (`REVIEW_REQUIRED`, a green validation run, passing tests) is **never** approval and does not replace step 1.

1. **Editorial review of the exact candidate.** A person reviews the specific candidate (identified by its id, version and hash in the review report), prose included, and records their approval against that hash in an **approval record** (below). Any later edit makes it a different candidate and restarts review.
2. **Mechanical revalidation (preflight).** `pnpm preflight:interactive --candidate <validated-candidate.json> --approval <approval.json>` re-runs the whole pipeline on the stored runtime definition (schema, authoring format, bounded play analysis, witness-route replay, narration checks), recomputes the canonical hash, rejects an already-published id/version, and checks the approval. It is read-only and prints `PUBLICATION_PREFLIGHT_PASSED` or `PUBLICATION_PREFLIGHT_FAILED [CODE]` (exit 0 / 1; 2 for usage errors).
3. **Immutable versioned definition.** The approved JSON is committed as `scenarios/<id>.v<N>.json`. Published definitions are append-only: a change is a new version, never an edit.
4. **Explicit source registration.** The definition is added to the `SCENARIOS` list in `scenarios/index.ts`, **and the approval record to `SCENARIO_APPROVALS` in `scenarios/approvals.ts`** (with tests and, optionally, a presentation pack). This static list is the publication authority.
5. **Catalogue metadata.** A hand-written `title` and spoiler-free `synopsis` for that exact (id, version) are added to `scenarios/catalogue-metadata.ts`. The registry refuses to load without metadata for the latest version, refuses metadata for anything unregistered, and keeps it out of the definition so its hash is unaffected.

Until step 4 a scenario cannot be started, and until step 5 the app will not boot with it registered. "The Last Tram" (`warsaw-last-tram` v1) has completed none of these steps: it stays `REVIEW_REQUIRED`, unregistered, absent from `GET /api/interactive/scenarios`, and rejected by session creation.

### Approval records

Successful authoring writes an extra `approval-template.json` beside the review artifacts. It is **PENDING**: no reviewer, no review timestamp, every checklist item `false`. Tooling never writes an approved record. A person completes it by hand:

```json
{
  "schemaVersion": "scenario-approval/v1",
  "scenario": { "id": "...", "version": 1 },
  "candidateHash": "<canonical hash from the review report>",
  "decision": "pending | approved | rejected",
  "reviewer": "<identifier>",
  "reviewedAt": "2026-01-31T09:30:00Z",
  "checklist": { "version": "editorial-checklist/v1", "items": { "unannotated-secrets": true, "...": true } }
}
```

An approval counts only when: the record is strict (unknown fields, unsupported record/checklist versions and malformed values are rejected); scenario id, version and `candidateHash` equal the candidate's (the hash is `hashScenarioDefinition`, canonical over the parsed definition, so reformatting or key order never matters while any prose or effect edit changes it); `decision` is `approved`; `reviewer` is a non-empty single-line identifier; `reviewedAt` is a real ISO-8601 UTC timestamp that is not in the future; and every checklist item is `true`. Failure codes: `APPROVAL_MISSING`, `APPROVAL_MALFORMED`, `APPROVAL_UNSUPPORTED_VERSION`, `APPROVAL_IDENTITY_MISMATCH`, `APPROVAL_HASH_MISMATCH`, `APPROVAL_PENDING`, `APPROVAL_REJECTED`, `APPROVAL_REVIEWER_INVALID`, `APPROVAL_TIMESTAMP_INVALID`, `APPROVAL_CHECKLIST_INCOMPLETE`; preflight adds `CANDIDATE_UNREADABLE|TOO_LARGE|NOT_JSON|INVALID`, `APPROVAL_UNREADABLE|TOO_LARGE|NOT_JSON` and `IDENTITY_ALREADY_PUBLISHED`.

**What this is not.** A record is a human-authored attestation. It is not an authenticated identity, a signature, or evidence that prose quality was verified by software; anyone with repository access can write one. Its value is that publication requires a deliberate, reviewable, hash-bound statement in source control rather than a green mechanical run.

### Registration guard and the legacy baseline

The real registry (`scenarios/index.ts`) is composed through `createGuardedScenarioRegistry`: every definition must be covered by exactly one matching approved record in `SCENARIO_APPROVALS`, otherwise the module throws `PublicationGuardError` at load and the application does not start. The injectable `createScenarioRegistry` used by tests is unchanged.

`warsaw-last-delivery@1` was published before approval records existed. It is pinned in `scenarios/legacy-baseline.ts` by exact id, version **and canonical hash**, labelled `EXISTING_PUBLISHED_CONTENT`; no retrospective human approval is claimed. The exception does not extend to an edited copy (`LEGACY_BASELINE_HASH_MISMATCH`), another scenario or a new version, which all need a real approval.

## Offline evaluation

`pnpm eval:interactive:authoring:offline` (also a CI step) runs fixed fixtures through the real pipeline with a scripted provider and an intercepted fetch: the valid original candidate and both ending routes; malformed JSON, unknown fields/effects, duplicate entries; changed or already-published identity; duplicate ids and unresolved references; a cyclic graph (rejected before exhaustive exploration); an unreachable ending, an unusable choice, a reachable dead end and a speaker-knowledge violation; over-long canonical narration; a valid repair and a repair that stays invalid; refusal, truncation, authentication, timeout, network and cancellation without repair; exhausted and exceeded call budgets; disabled implicit HTTP/network/timeout retries; mechanical validity without approval; and identical candidate hashes across repeated mock runs. It also runs the corpus cases described next.

### Evaluation corpus

The evaluation fixtures are a versioned corpus (`interactive-authoring-corpus/v1`, `src/interactive/authoring/corpus/`) of three entries. Each records its brief and candidate identity, canonical brief and candidate hashes, every terminal choice sequence with its ending, representative narration selected on different paths, the choices that must stay locked (with the engine's refusal code), and the gameplay it exercises.

| Entry | Identity | Emphasis | Terminal routes |
| ----- | -------- | -------- | --------------- |
| `last-tram` | `warsaw-last-tram@1` | the original fixture, reused by reference: item-gated and knowledge-gated choices, flag-conditional narration | 5 (2 endings) |
| `harbour-ledger` | `harbour-night-ledger@1` | knowledge-dependent dialogue: three `playerKnows` gates, `npcLearns` plus speaker knowledge, the same character speaking differently by what the player knows; no items | 6 (2 endings) |
| `clock-blackout` | `clock-museum-blackout@1` | single-use inventory: a key spendable on only one of two jobs, a one-time fuse, choices locked by a consumed or never-held item, four routes reconverging on one scene and two on one ending with narration recording what was spent | 6 (2 endings) |

Each new entry has distinct characters, scenes, choices, facts, narration and endings, and stays inside the authoring format (6-8 scenes, 3 decision points, 3 characters, 2 endings). The offline evaluation runs each of them through the real pipeline with the scripted provider: a first-pass success, a deliberate broken reference followed by exactly one repair (two requests, same brief), and its candidate paired with the other new entry's brief, which must be refused at the identity stage after the bounded repair. Accepted runs are also checked against the recorded hashes and, through the exhaustive route review, the recorded terminal sequences. The corpus spec additionally cross-checks the run reports (`parseRunReport`), the comparison aggregation (different brief hashes stay in separate groups, a wrong-brief refusal is filed under the brief it was run with), production replay and canonical narration validation, and that no corpus identity appears in the scenario registry, catalogue or presentation packs.

**Limitations.**

- The fixtures are hand-authored and every provider answer is scripted. A pass is deterministic regression coverage for validation, repair, reporting and route review across different story shapes. It is not evidence of real-model performance, and no paid call is made.
- All three entries are unpublished: none is in the scenario registry, the catalogue or a presentation pack, and none has an approval record. `warsaw-last-tram` remains unapproved and unregistered, and the mock provider still returns it only.
- Mechanical validity is still not editorial approval; the prose of the new fixtures has not been reviewed by an editor. Recorded narration probes pin which templates are selected and a few literal fragments, not prose quality.
- Editing a fixture changes its recorded hash, routes or narration probes and fails the corpus spec until the expectations are re-recorded on purpose.

## Comparing saved runs (offline report)

`pnpm report:interactive:authoring` summarizes runs you already have on disk, so authoring behaviour can be measured instead of remembered. It runs no model and makes no call.

```bash
pnpm report:interactive:authoring \
  --report apps/api/scenario-drafts/<run>--review-required/validation-report.json \
  --report apps/api/scenario-drafts/<run>--rejected/run-report.json \
  --format json
```

Paths are resolved from the directory the script runs in (`apps/api` under `pnpm`), so absolute paths are the safe choice. Only `validation-report.json` and `run-report.json` are accepted; there is no directory discovery, and candidate, review and approval files are never opened. At most 100 reports of at most 256 KiB each. `--format json` is the only format and the default.

**Exit codes:** `0` a valid report was printed (even if every supplied run failed authoring); `1` any supplied report is unreadable, malformed, duplicated (same file, symlink or identical bytes) or has inconsistent telemetry — nothing is printed to stdout, so an invalid input can never silently leave a denominator; `2` usage error. Failures name the report by position (`report #2`) and a fixed code, never a path, value or exception message. `pnpm` reports any non-zero script exit as `1`; the distinct `2` is visible only when the script is run directly (for example with `ts-node`). For clean machine-readable stdout, run `pnpm --silent report:interactive:authoring ...` from `apps/api`: the root wrapper and `--filter` runs print pnpm's own banner lines to stdout before the JSON.

**Consistency checks.** Besides the schema, each report's telemetry must agree with how the pipeline actually runs: request phases and outcomes, attempt sums, and the declared budgets. A repair is recorded as skipped (`skipped_budget_exhausted`) only if the declared request or HTTP budget was really used up by the generation request, and a repair is recorded as dispatched (completed, rejected, stopped or cancelled just before dispatch) only if both budgets were still available immediately before it. Attempts reported by a failed provider request are not capped by the declared budget, because that path reports them before the pipeline's budget check. A report that fails any check is `INCONSISTENT_TELEMETRY` with a fixed detail id (for example `repair-disposition` or `repair-budget`).

**Grouping.** Runs are compared only inside a group of identical provider, model, prompt version, wire schema version and brief hash. The output is sorted and byte-identical for any argument order.

**Metrics** (every rate is `null` when its denominator is 0, otherwise rounded to 4 decimals):

| Metric | Definition |
| ------ | ---------- |
| `samples`, `outcomes` | valid supplied reports; counts of REVIEW_REQUIRED / REJECTED / STOPPED |
| `firstPass` | `evaluated` = runs whose first candidate was validated; `passed` = of those, mechanically valid; `notEvaluated` = stopped before a first candidate was validated; `rate = passed / evaluated` |
| `repair` | `attempted` = repair requests dispatched; `evaluated` = repair candidates validated; `succeeded` = runs accepted from the repair candidate; `stoppedDuringRepair`; `skippedBudgetExhausted`; `successRate = succeeded / evaluated` |
| `finalValidity` | `evaluated` = REVIEW_REQUIRED + REJECTED; `valid` = REVIEW_REQUIRED; `rate = valid / evaluated`. STOPPED runs stay visible in `outcomes` |
| `rejectionStages`, `stopReasons` | counts for every stage and stop reason, zero-filled in pipeline order |
| `providerRequests`, `httpAttempts` | recorded request records and summed HTTP attempts (a mock request records no HTTP attempt) |
| `totalRunDurationMs` | min / median / max / mean of the recorded total run duration |
| `tokenUsage.input` / `.output` | `reportedTotal` sums only requests that reported the value (`null` if none did, `0` only when a provider really reported 0); `requestsReporting`, `requestsObserved`, `coverage`, `complete` |

**What this does not show.**

- The output is observations from the supplied artifacts, not a population estimate or a significance test.
- Mechanical validity means the deterministic stages passed. It is not editorial approval, prose quality or publication readiness.
- Mock, scripted and OpenAI-labelled runs are separate groups (`evidenceClass`), but a provider label does not prove a real paid call happened: reports are not authenticated.
- Unknown token usage is never zero or estimated, and no cost is computed.
- Durations are recorded run totals, not latency benchmarks.
- Real-model quality remains unverified, and `warsaw-last-tram` remains unapproved and unregistered.

## Authoring experiment runner (Phase 14.1)

`pnpm experiment:interactive:authoring` connects the corpus, the run reports, the comparison aggregation and the exhaustive route review into one small, reproducible workflow, so a separately authorized real-model evaluation is a single bounded command instead of a hand-assembled sequence. It is a harness, not a verdict.

```bash
# plan (default): prints the versioned JSON plan; no provider, no network, no file writes
pnpm --silent experiment:interactive:authoring
pnpm --silent experiment:interactive:authoring --model <name>       # plan naming a model (informational)

# offline: scripted fixture responses for all three briefs - HARNESS VERIFICATION, not model performance
pnpm experiment:interactive:authoring --mode offline

# openai: PAID. Do not run without separate authorization.
OPENAI_API_KEY=... pnpm experiment:interactive:authoring \
  --mode openai --allow-paid-calls --model <name>
```

The root script runs `pnpm --dir apps/api --silent experiment:interactive:authoring`; add `--silent` at the root (as for `review:interactive:routes`) to keep pnpm's own banner out of the plan JSON.

**Modes.**

| Mode | What it does | Side effects |
| ---- | ------------ | ------------ |
| `plan` (default) | prints `interactive-authoring-experiment-plan/v1` | none: no provider is constructed, the API key is not read, nothing is written |
| `offline` | runs the three corpus briefs with each entry's scripted fixture candidate | writes a fresh experiment directory; reports 0 HTTP attempts |
| `openai` | runs the same briefs through the existing OpenAI adapter | paid requests, plus the directory |

`openai` needs all of `--mode openai`, `--allow-paid-calls`, an explicit model (`--model` or `INTERACTIVE_AUTHORING_MODEL`) and `OPENAI_API_KEY`. An API key in the environment never enables execution: without the explicit mode the key is not even read. `--allow-paid-calls` is rejected in `plan` and `offline`, and `--model` is rejected in `offline`. There is no way to choose a different brief: the corpus is fixed (`interactive-authoring-corpus/v1`).

**Execution.** Exactly one authoring attempt per brief, sequentially, through `runAuthoring`, so each brief gets at most one generation plus one content repair. There are no transport retries, no concurrency, no repetitions, no automatic resume and no replacement attempts. The experiment directory is created before the first dispatch, so a paid request is never spent without somewhere to record it.

**Budgets (derived, not estimated).** With the three briefs and the existing per-brief limits, the maximum is 6 requests, 6 HTTP attempts, `6 x maxOutputTokens` output tokens (a per-request cap handed to the provider, not a usage figure) and `3 x deadlineMs` runtime (defaults: 8000 tokens per request, 300000 ms per brief, i.e. 48000 tokens and 900000 ms). No money is estimated and unreported usage is never guessed; observed counts come from what the pipeline recorded.

**Outcomes and stops.**

- A content `REJECTED` result is recorded and the next brief still runs, so all three are observed.
- A provider/transport stop (refusal, truncation, auth, rate limit, timeout, network, invalid response, deadline), a cancellation, an artifact-write failure or a progress-checkpoint failure stops before the next brief. Completed artifacts are preserved and unfinished work is marked `stopped` or `unattempted`.
- `SIGINT` aborts the in-flight request and no later brief starts, even if a provider answers late.
- Credentials, provider bodies and raw exception messages are never printed or recorded; only stable codes are.

**Artifacts.** Under the guarded drafts root (same rules as `author:interactive`: directory named `scenario-drafts`, not inside source/assets/build output/public, not a symlink), each experiment gets a fresh directory that is never overwritten:

```
<stamp>-authoring-experiment-<hex>.incomplete/   while running; renamed when finished
<stamp>-authoring-experiment-<hex>--complete/    every brief completed, every artifact written
<stamp>-authoring-experiment-<hex>--partial/     anything stopped, unattempted or missing
  manifest.json                  interactive-authoring-experiment-manifest/v2 (replaced atomically as work progresses)
  comparison-report.json         existing aggregation over the written run reports
  runs/<run>--review-required/   validated-candidate.json, validation-report.json,
                                 review-report.md, approval-template.json (PENDING)
  runs/<run>--rejected|--stopped/ run-report.json
  route-reviews/<key>.json|.md   exhaustive route review, mechanically accepted candidates only
```

The manifest records the configuration (corpus/prompt/schema versions, model, limits, derived budget, execution policy), each brief's identity and hash, its status (`completed` / `stopped` / `unattempted`, plus `awaiting_response` / `recording` in an intermediate checkpoint), relative artifact references, observed request and HTTP-attempt counts with explicit observation `coverage`, an explicit `completeness` status with reason codes, and the halt cause. Approval templates stay `pending`; nothing is approved or published. If the manifest itself cannot be written the directory is left `.incomplete` and the command says so.

**Progress checkpoints and interruption.** `manifest.json` is written before the first dispatch and then replaced (temporary file in the same directory, then rename; earlier experiments are never touched) at each step:

1. every entry `unattempted`;
2. the entry about to run is marked `awaiting_response`, with its exact identity and brief hash;
3. its authoring result and reported counts, status `recording`;
4. its artifact references, status `completed` or `stopped`;
5. the final manifest, before the directory is renamed.

Intermediate manifests carry `checkpoint.state: IN_PROGRESS`, `completeness.status: INCOMPLETE` and the reason `IN_PROGRESS`; only `FINAL` is a finished manifest. A checkpoint that cannot be written stops the experiment before the next dispatch (`CHECKPOINT_WRITE_FAILED`); if the first one fails, no provider call is made at all. A failed replacement leaves the previous complete checkpoint in place. The manifest schema is `interactive-authoring-experiment-manifest/v2` (v1 had no checkpoint, per-entry `usage` or observation `coverage`).

If the process is killed, the `.incomplete` directory keeps the last checkpoint: completed entries with their artifacts, the entry that was in flight, and `unattempted` for the rest. What that checkpoint does **not** establish:

- whether the process is still running: an `IN_PROGRESS` manifest is also what a slow live run looks like;
- whether an `awaiting_response` request completed, reached the provider or was billed, or what usage it incurred. Its counts are `null`, its `usage` is `UNKNOWN` (never zero), and `observed.coverage.status` is `PARTIAL`, so `observed.withinBudget` is `null` (not determined) rather than `true`. It is `false` only when the known counts already exceed a cap;
- what a `recording` entry managed to write: run directories under `runs/` that no entry references may exist, and a temporary `.manifest.json.*.tmp` file can remain if the kill landed mid-write (the manifest itself is intact).

Nothing resumes, retries or replaces an attempt automatically: an interrupted experiment is never continued, and a new run creates a new directory. `comparison-report.json` is written only when an experiment finishes; for an interrupted one, the run reports under `runs/` can be compared with `report:interactive:authoring`.

**Validation of real output.** A generated candidate is validated against its own brief (identity, characters, endings, structure, analysis, narration). It is deliberately not compared with the corpus fixtures' recorded candidate hash or routes: those pin hand-authored regression fixtures, not the only valid model output.

**Exit codes.** `0` plan printed, or the experiment is `COMPLETE` (all three briefs reached a final authoring result and every artifact was written; individual content rejections are observations, not failures); `1` the experiment is `INCOMPLETE` (stopped, cancelled, unattempted entries, artifact failure, failed route review) or its directory could not be created or finalised; `2` usage or configuration error, refused before any side effect. `pnpm` may collapse a non-zero script exit to `1` depending on how it is invoked; `pnpm --dir apps/api` preserves it.

**What a completed experiment does not show.**

- It is not approval, publication readiness or evidence of prose quality; mechanical validity only means the deterministic stages passed.
- `offline` replays scripted fixtures and verifies the harness. It says nothing about any model.
- One real run is one observation per brief: no variance, no significance, no latency benchmark.
- Real-model quality remains unverified, and every corpus scenario (including `warsaw-last-tram`) remains unpublished and unapproved.

## Inspecting a saved experiment (Phase 14.3)

`pnpm --silent inspect:interactive:experiment --manifest <manifest.json>` validates one saved `interactive-authoring-experiment-manifest/v2` file and summarises it as JSON. It is read-only: no resume, retry, repair, deletion or cleanup, no provider construction, no credentials, no network, no database, no file writes. It works on a `--complete`/`--partial` directory and on an `.incomplete` one a killed run left behind.

```bash
pnpm --silent inspect:interactive:experiment --manifest scenario-drafts/<experiment-dir>/manifest.json
```

**What is checked.**

- The strict v2 schema (an unknown key is an error); another schema version, including v1, is refused as `SCHEMA_UNSUPPORTED` and never reinterpreted.
- Unique entry identities; legal status/outcome/usage combinations per entry (unknown usage is never read as zero); the runner's ordering (settled entries, then at most one unresolved or stopped entry, then unattempted ones).
- Checkpoint state versus completeness, entry counts, reasons and halt information.
- Observed totals, coverage and `withinBudget`, recomputed with the runner's own `summarizeObservation`; the derived budget and execution policy.
- The artifacts the checkpoint **explicitly references**, nothing else: references must be relative paths of plain segments inside the manifest's directory (absolute paths, drive letters, backslashes, `..`, and symlinks/junctions on the way are refused), counts and read sizes are bounded, each referenced run report is re-parsed with `parseRunReport` and compared with the manifest (brief hash, provider/model, prompt/schema versions, outcome, repaired flag or stop reason, request and HTTP-attempt counts), and candidate, review and route-review files are checked for existence only (their prose is never read). Artifacts that were never recorded (an `awaiting_response` or `recording` entry has none yet) are valid; unreferenced files in the directory are not discovered or recovered.

**Output and exit codes.** One JSON document on stdout (`interactive-authoring-experiment-inspection/v1`): checkpoint and completeness state, per-entry status with reported or `UNKNOWN` usage (counts are `null`, never `0`), known totals with `coverage` and `totalsAreLowerBound`, artifact-check counts, and fixed `evidenceLimits` sentences. Only identifiers, enums, counts and fixed vocabulary are echoed: no absolute path, credential, prose, diagnostic message or raw exception.

| Exit | Meaning |
| ---- | ------- |
| `0` | valid inspection, including a valid incomplete checkpoint |
| `1` | unreadable, unsupported or inconsistent manifest or artifacts: stdout carries only `{ "status": "INVALID", "issues": [{ "code", "entry"? }] }`, never a partial summary |
| `2` | usage error (nothing on stdout) |

`pnpm` 9.4 reports any failed script as exit `1`, including through `pnpm --dir apps/api`; the exact `1`/`2` distinction is visible on the script process itself (`pnpm exec ts-node -r tsconfig-paths/register --project tsconfig.scripts.json scripts/inspect-interactive-experiment.ts ...`). The `status` field in stdout always tells the cases apart.

**Evidence limits.**

- An `IN_PROGRESS` checkpoint is the last saved state. It does not show whether a process is active, whether any process ended, or that any request failed or completed; `awaiting_response` means only that no result had been recorded.
- Unknown usage stays unknown and known counts are a lower bound unless `coverage` is `COMPLETE`. Nothing here establishes what was billed.
- A valid inspection means the checkpoint and the artifacts it names agree with each other. It is not editorial approval, not evidence of prose quality and not evidence that a model performed well.
