# Interactive story engine (v2: Phase 1 engine, Phase 2 web reader)

A small deterministic engine for one scripted detective scenario. Flow:
**create an authenticated session → read a scene → choose an available action → persist its consequences → resume the same session.**

It is independent of the book pipeline: no `GenerationRun`, outbox, BullMQ, claims or artifacts, no Redis use, no external AI call. Code lives in `apps/api/src/interactive/`.

## Scenario and versioning

- `warsaw-last-delivery` **v1** (English): a courier, a missing recipient and a suspicious parcel. Three characters, eight scenes, three decision points (`s-courtyard`, `s-door`, `s-cellar`), two endings (`quiet-delivery`, `ledger-exposed`). Branches reconverge at `s-door` and `s-cellar` and keep earlier consequences.
- The definition is JSON (`scenarios/warsaw-last-delivery.v1.json`) parsed by strict zod schemas into a typed `ScenarioDefinition`. Requirements (`playerKnows`, `hasItem`, `flag`, `notFlag`) and effects (`learnFact`, `npcLearns`, `giveItem`, `consumeItem`, `setFlag`) are a closed vocabulary; there are no expressions or scripts.
- At load time the scenario is checked for unique/well-formed ids, resolvable references, entry/terminal scenes, graph reachability, and then by **exhaustively playing** every reachable state: no dead ends, every ending and every choice usable, and no template that voices a fact its speaker has not learned.
- A new version is a new registry entry in `scenarios/index.ts`; published entries are never edited. A session stores `scenarioId` + `scenarioVersion` and the genesis event stores a content hash of the definition, so a session never adopts a newer or silently edited definition. A session pinned to a version the build does not ship is refused (`SCENARIO_VERSION_UNAVAILABLE`), not migrated.

Worked examples in v1:

| Rule          | Example                                                                                                                                                                                                      |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Knowledge     | `c-confront-ines` needs `playerKnows f-ines-altered-ledger`. Ines and Tomasz know it from the start; Mara only learns it in the flat. On the mailbox-stamp route she never does, so the choice stays locked. |
| One-time item | `entry-card` is `oneTime`. `c-use-card` consumes it; it moves from `inventory` to `consumedItems` and can never be used or granted again. The `parcel` is consumed by whichever ending path is taken.        |
| Locked branch | `c-use-card` requires the card (only `c-ask-caretaker` grants it); `c-follow-stamp` requires `f-ledger-stamp` (only `c-read-mailboxes` grants it). A locked choice is simply absent from the response.       |

## State and events

Immutable definitions (characters, facts, scenes) are separate from session state. `InteractiveState` holds: `revision`, `sceneId`, `playerKnowledge`, `npcKnowledge` (per NPC), `inventory`, `consumedItems`, internal `flags`, ordered `history`, and `endingId` (terminal outcome).

Events are created only by trusted server code; clients submit a choice command, never events, state, effects or narration.

| `seq` = `revision` | `type`           | payload                                           |
| ------------------ | ---------------- | ------------------------------------------------- |
| `0`                | `SessionStarted` | `scenarioId`, `scenarioVersion`, `definitionHash` |
| `1, 2, ...`        | `ChoiceMade`     | `choiceId`, `fromSceneId`                         |

Every event has `version` (currently `1`) and `stateHash = sha256(canonical state after the event)`.

Pure functions (`domain/engine.ts`, no DB/network/clock/randomness/Nest, inputs never mutated):

- `validateTransition(state, choiceId, scenario)` rejects unknown choices (including choices of other scenes), unavailable choices, consumed-item reuse, unlearned knowledge and any choice after an ending.
- `reduce(state | null, event, scenario)` applies one event; `null` accepts only genesis.
- `fold(events, scenario)` replays a full log and **rejects** a missing genesis, sequence gaps, duplicates, unsupported event versions, scenario/version/definition mismatches, impossible events and any stateHash drift. `verifyReplay` additionally requires the replay to equal the stored state and the final event hash.
- `applyChoice` / `startSession` build the next trusted event and state.

**Canonical hash.** Object keys are sorted; arrays that model sets (knowledge, inventory, consumed items, flags) are sorted and de-duplicated before hashing; `history` is an ordered list and keeps its order. Non-canonical values (`undefined`, `NaN`) throw. The hash does not depend on construction order.

## Persistence

Two new tables (one additive migration `20261009090000_interactive_engine`):

- `interactive_sessions`: `id`, `user_id` (FK, cascade), `scenario_id`, `scenario_version`, `revision`, `state` (validated JSON), timestamps; index `(user_id, created_at)`.
- `session_events`: `id`, `session_id` (FK, cascade), `seq`, `type`, `schema_version`, `payload`, `state_hash`, nullable `idempotency_key` / `request_hash` (null on genesis), `response`, `created_at`. Unique `(session_id, seq)` and `(session_id, idempotency_key)`.

`response` is a dedicated JSON column holding the accepted **public** scene view for that event. `GET` returns the latest event's stored response and an idempotent retry returns the original event's; narration is never regenerated for either. The session `state` always equals the replay of its events, and `revision` equals the latest `seq`.

## Revision and idempotency semantics

`POST /choices` runs in one transaction that first locks the session row (`SELECT ... FOR UPDATE`, filtered by the authenticated owner) with `SET LOCAL lock_timeout = 2s` and `statement_timeout = 5s` (a timeout returns `503 SESSION_BUSY`). Then, in order:

1. Ownership: a missing session and another user's session both return the same `404 SESSION_NOT_FOUND`, before any idempotency lookup.
2. Look up `(sessionId, idempotencyKey)`. Same fingerprint (`sha256` of `choiceId` + `expectedRevision`) returns the saved response, even after later choices advanced the session. A different fingerprint returns `409 IDEMPOTENCY_KEY_REUSED`.
3. `expectedRevision` must equal the session revision, else `409 REVISION_CONFLICT`.
4. Validate the choice (`422 UNKNOWN_CHOICE`, `409 CHOICE_UNAVAILABLE`, `409 SESSION_TERMINAL`). Reasons behind an unavailable choice are not disclosed.
5. Revalidate the prepared narration against the state being committed.
6. Insert exactly one event, then advance the session with a conditional `UPDATE ... WHERE revision = expected`; both commit or roll back together.

Failed commands never reserve a key. The same key is valid in different sessions. Two requests with different keys at the same revision produce one transition and one `REVISION_CONFLICT`; two identical requests produce one event and equal responses.

## Narration and its limits

`NarratorProvider` (`narrator/narrator.ts`) is injectable (`NARRATOR_PROVIDER`; `MockNarratorProvider` is the only implementation). It receives the validated post-transition state and returns `unknown`, which is accepted only if it passes `validateNarration`. Narration is prepared **outside** the write transaction (a future network provider must never run inside one) and its scene/state binding is revalidated under the lock; if the state moved on, it is re-prepared.

The closed contract: scenario id/version, scene id, hash of the narrated state, approved `templateIds`, `utterances` (speaker + fact), and `text`. Accepted only when the templates are exactly those the scenario selects for that state, every speaker/fact exists, every speaker knows the facts they voice, and `text` equals the trusted rendering. Rejected output is `NARRATION_MALFORMED` (incl. oversized), `NARRATION_BINDING_MISMATCH`, `NARRATION_UNKNOWN_TEMPLATE|SPEAKER|FACT`, `NARRATION_KNOWLEDGE_UNAVAILABLE`, `NARRATION_TEMPLATE_MISMATCH`, `NARRATION_UTTERANCE_MISMATCH` or `NARRATION_TEXT_MISMATCH`; the API maps these to `502 NARRATION_INVALID` and writes nothing.

**What this does not guarantee.** It does not detect contradictions in arbitrary natural language: because prose must equal approved template text, contradictions are impossible by construction, not detected. Free-form or LLM narration is a later phase and needs its own validation design.

## Replay and public-view boundary

Replay is complete from the genesis event and the pinned scenario. The public view (`public-view.ts`) is built from an allow-list: session id/revision, scenario id/version, current scene id/title, validated narration, **currently available** choices (id, label), the player's learned facts and held items, status and ending. It never includes NPC knowledge, internal flags, consumed items, event payloads, hashes, narration validation evidence, locked choices or future scenes.

## Local commands

```bash
pnpm test:infra:up                                   # disposable Postgres :5440 / Redis :6380
pnpm --filter @book/api prisma:generate
pnpm --filter @book/api test                         # unit tests (no services)
pnpm eval:interactive:offline                        # in-memory evaluation, no services/keys
pnpm --filter @book/api test:integration test/integration/interactive   # guarded runner
pnpm --filter @book/api typecheck:integration:hardening
pnpm test:infra:down
```

The offline evaluation (`scripts/eval-interactive-offline.ts`) runs valid routes and adversarial transition, replay (including duplicate-event) and narration cases with fixed expectations and exits non-zero on any unexpected outcome. It does not prove HTTP duplicate-request, idempotency or concurrency behaviour; the PostgreSQL integration tests do.

## API walkthrough

All routes are under `/api` and need the normal authentication (shown with a bearer token).

```bash
# 1. Create a session
curl -s -X POST $API/api/interactive/sessions -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"scenarioId":"warsaw-last-delivery"}'
# -> 201 {"sessionId":"<id>","revision":0,"scene":{"id":"s-courtyard",...},"narration":"...",
#         "choices":[{"id":"c-ask-caretaker",...},{"id":"c-read-mailboxes",...}],...}

# 2. Read (resume) it at any time
curl -s $API/api/interactive/sessions/<id> -H "Authorization: Bearer $TOKEN"

# 3. Choose; the same body is safely retryable
curl -s -X POST $API/api/interactive/sessions/<id>/choices -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"choiceId":"c-ask-caretaker","expectedRevision":0,"idempotencyKey":"7c1f6a52-0001"}'
# -> 200 {... "revision":1, "scene":{"id":"s-caretaker"} ...}
```

Stable error codes: `INVALID_REQUEST` (400), `SESSION_NOT_FOUND` (404), `UNKNOWN_CHOICE` / `UNKNOWN_SCENARIO` (422), `REVISION_CONFLICT`, `IDEMPOTENCY_KEY_REUSED`, `CHOICE_UNAVAILABLE`, `SESSION_TERMINAL` (409), `NARRATION_INVALID` / `NARRATION_PROVIDER_FAILED` (502), `SESSION_BUSY` (503).

## Intentional limits

No images or PDF; no real LLM narrator or user-authored scenarios; no per-user session cap or rate-limit policy yet (the standard `UserRateLimitGuard` is applied but no `@RateLimit` budget is configured); no event-sourcing framework beyond this single session log. The only UI is the Phase 2 reader below.

## Phase 2: playable web reader

A minimal browser experience for the one shipped scenario. The API, engine, HTTP paths, payloads and status codes are unchanged; the only API edit is a compile-time check in `public-view.ts` that the schema-inferred view stays mutually assignable to the public contract.

**Routes** (inside the authenticated dashboard; an `Interactive story` link sits next to `Child profiles`):

| Route                                | What it does                                                                                                                                                                       |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/dashboard/interactive`             | Short introduction and an explicit **Start story** button. A session is created only by that click, never on mount.                                                                |
| `/dashboard/interactive/[sessionId]` | The reader: scene, narration (plain text, blank lines = paragraphs), server-provided choices, clues, items, ending. Reload fetches the same session (`GET`); it never creates one. |

**Contract.** Public request/response types live in `@book/types` (`interactive.types.ts`: `InteractiveSessionViewDto`, `SubmitInteractiveChoiceInput`, `InteractiveErrorCode`). Runtime validation stays in the API. The browser never imports the scenario JSON or domain modules and only renders what the API returns, so locked branches, future scenes, NPC knowledge and flags never reach it. The wrapper is `apps/web/src/lib/api/interactive.ts`, built on `apiFetch`, so authentication and the 401-refresh flow are unchanged.

**Reader behaviour** (`use-interactive-reader.ts`):

- The server owns state. Nothing advances optimistically: scene, clues, items and revision change only when an authoritative response is applied.
- Each deliberate choice captures `choiceId`, the displayed `expectedRevision` and one `crypto.randomUUID()` key. That command is immutable until its outcome is resolved. A synchronous single-flight guard (not just disabled buttons) blocks duplicates and any other choice while a command is unresolved.
- Every request has a local abortable deadline (15 s). A timeout, network failure or lost response is treated as an _unknown outcome_: the reader offers **Retry choice**, which resends the exact original command (same key, same revision). There is no automatic retry loop. Cancelling stops local waiting, not necessarily server execution.
- After a retry succeeds, the saved response is **not** displayed as current state (an exact retry may return its original response after later choices advanced the session). The reader refreshes first; choices stay blocked until that refresh returns, and if it fails the known state is kept with a **Check again** action.
- `REVISION_CONFLICT`, `CHOICE_UNAVAILABLE`, `SESSION_TERMINAL` (and `UNKNOWN_CHOICE`): the command is resolved as rejected, a brief explanation is shown, the authoritative state is fetched, and the user must choose again. Nothing is resubmitted against a newer revision. If the reload fails, choices stay blocked until it succeeds.
- `IDEMPOTENCY_KEY_REUSED` is shown as a consistency error with a **Reload story** action; no new key is minted.
- `SESSION_BUSY`, narration failures and 429/5xx allow a bounded, manual retry of the same command. `SESSION_NOT_FOUND` shows one "This story isn't available" screen for missing and foreign sessions alike. A definitive 401 leaves the redirect to the existing auth layer.
- A displayed revision is never replaced by an older one. Every async completion is guarded by the active session id, a scope generation and the auth _session epoch_ (`getSessionEpoch()`), so late results after a route change, unmount, logout/login as the same account, or an account switch are dropped and their requests aborted.
- Refresh happens on reader entry and when the tab regains focus/visibility, coalesced and skipped when the state is under 5 s old. No polling or realtime.

### Commands

```bash
pnpm --filter @book/types build
pnpm --filter @book/web test
pnpm --filter @book/web typecheck && pnpm --filter @book/web lint
NEXT_PUBLIC_API_URL=http://localhost:4000/api pnpm --filter @book/web build   # the build needs a public API URL
pnpm test:infra:up                                                            # disposable Postgres :5440 / Redis :6380
pnpm --filter @book/web test:e2e e2e/interactive.spec.ts                      # real API + browser; the API starts through the guarded launcher
pnpm test:infra:down
```

`e2e/interactive.spec.ts` has two groups. The real-API journeys cover both endings, reload mid-story, foreign/missing sessions and a cross-tab conflict. A separately labelled group injects one transport failure in the browser: the response to a real choice request is dropped, the identical command is retried, and exactly one transition is recorded. The E2E API budget for `/auth/refresh` per IP (`AUTH_RATE_LIMIT_IP_MAX_ATTEMPTS`) is raised in `playwright.config.ts`, because every full page load in JWT mode restores the session through it.

### Deferred / known limitations

- Session creation has no idempotency contract. Concurrent creation from one page is prevented and an ambiguous create (timeout, lost response) is never retried automatically, but exactly-once creation is **not** guaranteed: the user is warned that trying again may create a second story. A timed-out create can still leave an unreferenced session behind.
- An unresolved command lives in memory only. Reloading restores server state through `GET`; if a choice's outcome was unknown at that moment, the reload shows whatever the server recorded and the pending retry is gone. Durable recovery across reload is deferred (no localStorage story cache, service worker or offline outbox).
- No session list, per-user session cap or rate-limit budget, and the scenario id is fixed to `warsaw-last-delivery`. These are required before any public launch.
