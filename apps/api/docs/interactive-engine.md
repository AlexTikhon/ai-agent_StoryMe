# Interactive story engine (v3: Phase 1 engine, Phase 2 web reader, Phase 3 session library, Phase 4 illustrated reader, Phase 6.1 catalogue)

A small deterministic engine for one scripted detective scenario. Flow:
**create an authenticated session (idempotently) → read a scene → choose an available action → persist its consequences → find and resume the same session later.**

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

- `interactive_sessions`: `id`, `user_id` (FK, cascade), `scenario_id`, `scenario_version`, `revision`, `state` (validated JSON), timestamps; index `(user_id, created_at)`. Phase 3 adds nullable `creation_idempotency_key` / `creation_request_hash` and a unique `(user_id, creation_idempotency_key)` (migration `20261009120000_interactive_session_creation_identity`).
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
pnpm eval:interactive:authoring:offline              # scenario-authoring evaluation (see interactive-authoring.md)
pnpm --filter @book/api test:integration test/integration/interactive   # guarded runner
pnpm --filter @book/api typecheck:integration:hardening
pnpm test:infra:down
```

The offline evaluation (`scripts/eval-interactive-offline.ts`) runs valid routes and adversarial transition, replay (including duplicate-event) and narration cases with fixed expectations and exits non-zero on any unexpected outcome. It does not prove HTTP duplicate-request, idempotency or concurrency behaviour; the PostgreSQL integration tests do.

## API walkthrough

All routes are under `/api` and need the normal authentication (shown with a bearer token).

```bash
# 1. Create a session (the key identifies one deliberate "start"; resending it is safe)
curl -s -X POST $API/api/interactive/sessions -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"scenarioId":"warsaw-last-delivery","idempotencyKey":"start-7c1f6a52"}'
# -> 201 {"sessionId":"<id>","revision":0,"scene":{"id":"s-courtyard",...},"narration":"...",
#         "choices":[{"id":"c-ask-caretaker",...},{"id":"c-read-mailboxes",...}],...}

# 2. Read (resume) it at any time
curl -s $API/api/interactive/sessions/<id> -H "Authorization: Bearer $TOKEN"

# 2b. List your sessions, newest first (page shape: see "Phase 3")
curl -s "$API/api/interactive/sessions?limit=20" -H "Authorization: Bearer $TOKEN"

# 3. Choose; the same body is safely retryable
curl -s -X POST $API/api/interactive/sessions/<id>/choices -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"choiceId":"c-ask-caretaker","expectedRevision":0,"idempotencyKey":"7c1f6a52-0001"}'
# -> 200 {... "revision":1, "scene":{"id":"s-caretaker"} ...}
```

Stable error codes: `INVALID_REQUEST` (400), `SESSION_NOT_FOUND` (404), `UNKNOWN_CHOICE` / `UNKNOWN_SCENARIO` (422), `REVISION_CONFLICT`, `IDEMPOTENCY_KEY_REUSED`, `CHOICE_UNAVAILABLE`, `SESSION_TERMINAL` (409), `NARRATION_INVALID` / `NARRATION_PROVIDER_FAILED` (502), `SESSION_BUSY` (503). Phase 3 adds `SESSION_LIMIT_REACHED` (409) and the shared limiter codes `RATE_LIMITED` (429, with `Retry-After`) and `RATE_LIMIT_UNAVAILABLE` (503, fail-closed).

## Intentional limits

No images or PDF; no real LLM narrator or user-authored scenarios; no event-sourcing framework beyond this single session log. The UI is the Phase 2 reader and the Phase 3 library below. The per-user session cap and request budgets arrived in Phase 3 and are private-pilot assumptions.

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

- _Resolved in Phase 3:_ session creation now has an idempotency contract (below). What remains: the held creation command lives in memory only, so a reload forgets it; the committed session is then found through "Your stories".
- An unresolved command lives in memory only. Reloading restores server state through `GET`; if a choice's outcome was unknown at that moment, the reload shows whatever the server recorded and the pending retry is gone. Durable recovery across reload is deferred (no localStorage story cache, service worker or offline outbox).
- _Resolved in Phase 3:_ session list, per-user session cap and rate-limit budgets. The scenario id is still fixed to `warsaw-last-delivery` in the browser.

## Phase 3: resumable session library, idempotent creation, bounded sessions

Preparation for a **private pilot**, not authorization to deploy publicly. Choice semantics, the engine, events and legacy sessions are unchanged.

### Idempotent creation

`POST /api/interactive/sessions` takes `{ scenarioId, idempotencyKey }` (Phase 6.1 adds an optional `scenarioVersion`; see below). The key is required and uses the same bounded format as choice keys (`[A-Za-z0-9._:-]{1,128}`). The creation fingerprint is `sha256(canonical {scenarioId})` (the validated command without the key), stored on the session as `creation_request_hash` next to `creation_idempotency_key`. Existing sessions have both columns `NULL`; PostgreSQL unique indexes treat `NULL`s as distinct, so they never collide.

| Request                                         | Result                                                                            |
| ----------------------------------------------- | --------------------------------------------------------------------------------- |
| New key                                         | New session + genesis event + identity commit atomically (`201`)                  |
| Same owner, same key, same fingerprint          | The **stored genesis response** and the original `sessionId`, even if it advanced |
| Same owner, same key, different fingerprint     | `409 IDEMPOTENCY_KEY_REUSED`; nothing is written                                  |
| Another owner, same key                         | Independent (the unique key includes the owner)                                   |
| A creation that failed (narration, DB, timeout) | Nothing persisted, so the key is **not** reserved and may be used again           |

Order inside `createSession`: (1) resolve an existing identity from the database **before** any narration, so a replay never narrates again and never depends on the latest scenario version; (2) prepare narration outside any transaction; (3) in one transaction take the admission lock, **re-check** the identity, then evaluate the cap, then insert session + genesis. An accepted retry therefore still succeeds when the owner is at the cap. The replayed response is the creation-time view: clients must navigate to the session and let the reader fetch current state rather than treat it as the current scene.

### Concurrent session cap

`INTERACTIVE_MAX_SESSIONS_PER_USER` (default **50**) counts **every retained session, completed ones included**. Beyond it a new creation returns `409 SESSION_LIMIT_REACHED`. Session deletion/retention does not exist yet, so a user who reaches the cap cannot free room; that is an explicit limitation of this phase.

Admission is serialized per owner by locking that owner's `users` row inside the creation transaction:

```sql
SET LOCAL lock_timeout = '2000ms'; SET LOCAL statement_timeout = '5000ms';
SELECT id FROM users WHERE id = $1 FOR NO KEY UPDATE;   -- then: identity re-check -> COUNT -> INSERT
```

- **Why this lock.** Count and insert happen under the same lock in the same transaction, so no concurrent creation can slip between them; there is no unlocked count-then-create. It also confirms the owner row still exists.
- **Contention trade-off.** `FOR NO KEY UPDATE` conflicts with other admissions for the **same user** and with other writers of that user row (credits, profile updates), but **not** with foreign-key checks, so unrelated inserts that merely reference the user (books, events) are not blocked. The lock is held for one short transaction and never across narration. Different users do not contend. A waiter that cannot get the lock within 2 s, or a statement/transaction timeout, becomes the stable, retryable `503 SESSION_BUSY`.

### Request budgets (attempts) vs the session cap (created sessions)

Budgets reuse the existing `@RateLimit` decorator and `UserRateLimitGuard` (Redis-backed, per user, **fail-closed**: `429 RATE_LIMITED` / `503 RATE_LIMIT_UNAVAILABLE`). They count **request attempts, idempotent retries included**. The cap counts **sessions actually created**, so a replay consumes budget but never quota.

| Setting (`..._WINDOW_MS` / `..._MAX_ATTEMPTS`) | Default     | Applies to                                                  |
| ---------------------------------------------- | ----------- | ----------------------------------------------------------- |
| `INTERACTIVE_CREATE_RATE_LIMIT_*`              | 10 min / 5  | `POST /sessions`                                            |
| `INTERACTIVE_CHOICE_RATE_LIMIT_*`              | 1 min / 60  | `POST /sessions/:id/choices`                                |
| `INTERACTIVE_READ_RATE_LIMIT_*`                | 1 min / 120 | `GET /sessions/:id` and `GET /sessions` (separate counters) |
| `INTERACTIVE_MAX_SESSIONS_PER_USER`            | 50          | retained sessions per user                                  |

These are **initial private-pilot assumptions, not measured production limits**; tune them from observed use. No other endpoint's budget changed.

### Session library API

`GET /api/interactive/sessions?limit=20&cursor=...` returns `{ sessions: [...], nextCursor }`, an explicit allow-list per entry: `sessionId`, `scenarioId`, `scenarioVersion`, `scenarioTitle` (Phase 6.1), `sceneTitle`, `status` (`in_progress` | `ended`), `endingTitle`, `createdAt`, `updatedAt`. It never contains state JSON, narration, clues, inventory, event payloads, hashes, idempotency keys, NPC knowledge or future scenes. Titles come from each session's stored public view for its current revision.

- **Keyset pagination** ordered by `(created_at DESC, id DESC)`; the cursor is the opaque base64url of the last row's `{t, i}` and is strictly validated (length, base64url, JSON shape, ISO time, UUID), so a forged cursor is `400 INVALID_REQUEST`. `limit` is digits only, 1-50 (default 20); repeated or unknown query parameters are rejected.
- **Owner isolation.** Every query filters by the authenticated user; a cursor from another account can only position within the caller's own rows. The existing `(user_id, created_at)` index already serves the query (an owner has at most the cap's rows), so no new index was added.
- Sessions created while paging may appear after a refresh; there is no snapshot pagination.

### Web: "Your stories"

`/dashboard/interactive` gains a "Your stories" section (loading, empty, error with retry, refresh, load-more, in-progress vs completed, **Continue** / **Read again** links to the reader URL). **Start story** stays an explicit action. There is no search, deletion or management UI (the story catalogue arrived in Phase 6.1, below).

- `use-session-library.ts` binds every request to a scope (account id, auth session epoch, generation). Responses for another account, another auth session, an unmounted page, or a request a refresh made obsolete are dropped and aborted; the owner is stored with the data so another account's list is not rendered even for one frame.
- `use-start-story.ts` creates **one immutable command per deliberate start** (`crypto.randomUUID()` key). After an ambiguous result (network failure, timeout, unlabelled 5xx), a rate limit, or `SESSION_BUSY`, the alert offers **Try again**, which resends the identical command (same key and body); nothing is retried automatically. A definitive rejection (e.g. `SESSION_LIMIT_REACHED`) resolves the command so the next start is new. After success or replay it navigates to the returned session id and the reader fetches the current state.
- The held command is in memory only. A reload forgets it, but a committed session remains discoverable through the library.

### Tests and commands

```bash
pnpm test:infra:up
pnpm --filter @book/api test:integration test/integration/interactive   # engine, concurrency, HTTP, creation identity, cap, library
pnpm --filter @book/web test:e2e e2e/interactive.spec.ts                # real API + browser (guarded launcher)
pnpm test:infra:down
```

The cap and identical-creation tests use an `AdmissionGate` (test helper): every concurrent transaction is held right after its count / identity re-check until all of them are either at the gate or blocked on the admission lock (read from `pg_stat_activity`), so without the lock they would all pass together and overshoot. Removing `FOR NO KEY UPDATE` makes these tests fail. The Playwright run raises `INTERACTIVE_CREATE_RATE_LIMIT_MAX_ATTEMPTS` **only** in `playwright.config.ts` (the shared synthetic owner starts more than 5 stories per 10 minutes); production defaults are untouched. Transport failures in the E2E suite are injected by the browser (`page.route`), not caused by a real network fault, and live in separately named groups.

### Phase 3 limitations

- **No retention or deletion.** Sessions are kept forever and all count toward the cap; a user at the cap cannot start another story. Retention/deletion must be designed before more than a private pilot.
- **No recovery across reload for creation.** The pending creation command is memory-only. After a reload the user sees the library, not a retry prompt. That is acceptable because a committed session is listed, and a creation that never reached the server leaves nothing behind.
- Budgets and the cap are unmeasured assumptions. The cap is per user, not per organisation or IP.
- A session whose current-revision event is missing is logged and omitted from the list rather than failing the whole page.
- A reused key with an unknown scenario id reports `IDEMPOTENCY_KEY_REUSED` (identity is checked first), not `UNKNOWN_SCENARIO`.

## Phase 4: illustrated reader (presentation packs)

Presentation is **separate from story semantics**. The scenario JSON (and its hash), state, event schema, replay, narrator contract, persisted event responses and create/choice idempotency are untouched; there is no migration. A presentation pack only says which picture accompanies which scene.

### Presentation packs

`src/interactive/presentation/` holds typed data validated at load (zod, strict; no expressions, templates, remote URLs or model-generated metadata):

- `packId`, `packVersion`, the `scenarioId`/`scenarioVersion` it illustrates, and `scenes`: sceneId → panels.
- A panel is `{ id, src, width, height, alt }`. `src` must match `/interactive/<packId>/v<packVersion>/<name>.svg` (same-origin, versioned, allow-listed; no query strings, traversal, remote or `data:` URLs).
- The registry (`presentation.ts`) is keyed by scenario `(id, version)`. At startup a pack must cover **every** scene of its scenario and name none that does not exist, otherwise the process refuses to load it.

`warsaw-noir` v1 maps all eight `warsaw-last-delivery` v1 scenes: `s-courtyard`, `s-caretaker`, `s-mailboxes`, `s-door`, `s-flat`, `s-cellar`, `s-end-quiet`, `s-end-exposed`.

**Version semantics.** Published pack versions are immutable: changed or replacement artwork (for example raster art later) is a new `packVersion` with its own asset directory, never an edit of files under an existing one. Story versions are pinned to sessions; **the pack is not**. It is selected from the registry at read time, so this phase does not promise historically pinned artwork: when a newer pack for the same scenario version is published, existing sessions will show it.

### `GET /api/interactive/sessions/:id/presentation?expectedRevision=N`

Same authentication, strict parameter validation (`expectedRevision` required, digits only, no repeats or extra keys, ≤ 1,000,000) and read-rate budget (`INTERACTIVE_READ_RATE_LIMIT_*`) as the other reads.

The owned session is resolved through the existing public-view read (`getSession`); the presentation is selected from that view. No second interpretation of internal state.

```jsonc
// 200
{
  "sessionId": "…",
  "revision": 1,
  "scenarioId": "warsaw-last-delivery",
  "scenarioVersion": 1,
  "sceneId": "s-caretaker",
  "presentation": {
    "packId": "warsaw-noir",
    "packVersion": 1,
    "panels": [
      {
        "id": "p-caretaker",
        "src": "/interactive/warsaw-noir/v1/s-caretaker.svg",
        "width": 1200,
        "height": 800,
        "alt": "…",
      },
    ],
  },
}
```

- Missing and foreign sessions: the same `SESSION_NOT_FOUND` response, whatever `expectedRevision` is.
- Any revision other than the current one: `REVISION_CONFLICT` (409), with no scene information.
- Unknown scenario/version or unmapped scene: `presentation: null` (not an error); the text reader is complete without art.
- Only the **current scene's** panels are returned. Never the manifest, future scene ids or panels, hidden knowledge, flags, events, state hashes or narration.
- Strictly read-only: no writes, no narration or provider calls, no regeneration.
- `Cache-Control: private, no-store`: the metadata is authenticated and must not be shared-cached.

### Public asset boundary

Artwork files live in `apps/web/public/interactive/<packId>/v<N>/` and are **public static files**: authentication protects the _session metadata_ (which scene a session is at), **not** the downloadable artwork. Anyone who knows or guesses a path can fetch it; the filenames are not obscured and nothing about spoiler secrecy is implied. Do not put art for scenes that must stay unseen anywhere other than a future, separately designed private store.

### Assets, provenance, sizes

Eight original SVG scene illustrations, hand-authored as vector source for this project (no third-party artwork, stock images, downloads, paid tools or provider calls). They share one Warsaw-noir visual language (rain, charcoal tones, restrained amber light) but each has its own composition: courtyard, gateway with the caretaker, mailbox wall, fourth-floor landing, lamp-lit flat, brick cellar workshop, a departure street and a lamp-lit table with an open ledger.

| File                | Bytes |
| ------------------- | ----- |
| `s-courtyard.svg`   | 4,919 |
| `s-caretaker.svg`   | 3,940 |
| `s-mailboxes.svg`   | 5,205 |
| `s-door.svg`        | 4,320 |
| `s-flat.svg`        | 3,977 |
| `s-cellar.svg`      | 3,912 |
| `s-end-quiet.svg`   | 3,831 |
| `s-end-exposed.svg` | 3,720 |

All are 1200×800 (3:2), ~33.8 KB in total, with no scripts, event handlers, `foreignObject`, embedded HTML, `<text>`, `<image>`, or external references (only internal `url(#id)` fragments); this is enforced by `presentation.spec.ts`. They are loaded through `<img>`, which does not execute SVG scripts.

Alt text describes what is visible and adds nothing the player has not been told by the current scene; no unrevealed evidence is drawn or named. `s-end-quiet` is reached by three routes (parcel handed over via the flat, via the stamp, or left at the door), so its art is a neutral departure (a cyclist riding away from a courtyard gate) that asserts neither delivery; a test pins that the alt text names neither route.

These are **prototype art**. Later raster artwork replaces them through a new presentation-pack version.

### Web: illustrations beside the text

- `use-scene-presentation.ts` fetches only after the reader has an authoritative view, and is independent of choice submission and state recovery.
- Every answer is bound to session, displayed revision, scene, scenario id/version, user and auth epoch, and used only while that exact scope is still displayed. After a choice, route change, unmount or logout/login (even as the same account) a late answer is discarded, so old-scene art can never sit under new-scene text, not even for one render.
- Loading reserves a 3:2 box (a quiet pulse, no spinner, no live-region noise). Panels render in a `<figure>` with `alt`; text, choices, clues and endings stay HTML.
- Failure never blocks play. A metadata outage or a broken image shows "The illustration isn't available right now. The story continues in text." with a bounded manual **Reload illustration** (2 per scene). `REVISION_CONFLICT`, `SESSION_NOT_FOUND` and 401 are left to the reader's own recovery and show nothing extra. No automatic retry, polling, or preloading of future scenes.
- The reader's choice idempotency, monotonic revision guard and recovery semantics are unchanged.

### Tests and commands

```
pnpm --filter @book/api test                     # pack coverage, asset safety, projection, request/controller specs
pnpm --filter @book/api test:integration test/integration/interactive   # HTTP: ownership, conflict, read-only (events/state hashes/narrator untouched)
pnpm --filter @book/web test                     # hook races (deferred promises), reader fallbacks
pnpm --filter @book/web test:e2e e2e/interactive.spec.ts   # real API + browser: both endings, reload, injected failures, desktop/mobile layout
```

The Playwright run writes visual-QA screenshots to `apps/web/test-results/interactive-visual/` (git-ignored). Screenshots are visual QA, not proof of concurrency correctness; the race tests use deferred promises.

### Phase 4 limitations

- Art is not historically pinned (see above) and the SVGs are prototype quality.
- Dialogue is not extracted into the picture or into speech bubbles; one panel per scene.
- The public artwork can be fetched without logging in.
- On narrow phones the existing dashboard top navigation clips its leftmost link; that is dashboard chrome outside the reader and was not changed here.

## Phase 6.1: published-scenario catalogue and version-aware creation

The browser no longer knows any story. It asks the server which stories are published and starts the exact (id, version) it was offered. No migration: the existing `scenario_version` and `creation_request_hash` columns carry everything.

### Catalogue

- `GET /api/interactive/scenarios` (same `AuthModeGuard` + `UserRateLimitGuard` and the shared `INTERACTIVE_READ_*` budget as the other reads; `Cache-Control: private, no-store`; query parameters are rejected) returns `{ scenarios: [{ scenarioId, scenarioVersion, title, language, synopsis }] }`: one entry per published scenario, for its **latest** published version, sorted by id. That five-field DTO (`InteractiveScenarioCatalogueEntryDto`) is the entire surface; definitions, scenes, choices, conditions, facts, endings, draft/review reports and provider output are never serialized.
- The static published registry in `scenarios/index.ts` remains the **publication authority**. Catalogue metadata (`title`, hand-written spoiler-free `synopsis`) lives in `scenarios/catalogue-metadata.ts`, outside the scenario JSON, so adding or fixing a synopsis never changes a definition hash. Metadata is keyed by (id, version) so a session pinned to v1 keeps its v1 title after v2 ships.
- `createScenarioRegistry` (`scenarios/registry.ts`) validates at module load and refuses to start on: metadata for an unpublished identity, duplicate metadata, duplicate definitions, a scenario whose **latest** version has no metadata, or a title/synopsis that is empty, multi-line or over 80 / 400 characters.
- "The Last Delivery" (`warsaw-last-delivery` v1) is the only published scenario. "The Last Tram" (`warsaw-last-tram`) stays `REVIEW_REQUIRED`: unregistered, not in the catalogue, and rejected by creation with `422 UNKNOWN_SCENARIO`.
- `InteractiveService` takes the registry as an optional 4th constructor argument (token `SCENARIO_REGISTRY`, defaulting to the published one). Tests use it to inject test-only registries; nothing test-only is registered as real content.

### Version-aware creation

`POST /api/interactive/sessions` accepts an optional integer `scenarioVersion` (1-1,000,000).

| Request                   | Resolution                                     | Fingerprint stored as `creation_request_hash`                    |
| ------------------------- | ---------------------------------------------- | ---------------------------------------------------------------- |
| `scenarioVersion` present | exactly that published version; never upgraded | `sha256(canonical { scenarioId, scenarioVersion })`              |
| omitted                   | latest published version (unchanged behaviour) | `sha256(canonical { scenarioId })`, **exactly** the pre-6.1 hash |

- An existing creation identity (`userId`, key) is resolved **before** the registry is consulted or anything is narrated. An identical retry returns the original genesis response even if that version is no longer published; a different fingerprint (another version, or explicit vs omitted) is `409 IDEMPOTENCY_KEY_REUSED`.
- Unknown id, unpublished id (Last Tram) or unpublished version: `422 UNKNOWN_SCENARIO`, with no session or event created.
- Admission locking, the per-user cap, narration outside the transaction, immutable version pinning and all choice/replay semantics are unchanged.
- **Compatibility decision:** an old client that omits the version and later retries with an explicit `scenarioVersion` equal to what it got is a _different_ command and is rejected with `IDEMPOTENCY_KEY_REUSED`. Preserving old hashes was chosen over treating omitted == latest, because "latest" changes over time and the hash must not.

### Session titles

Session summaries gain `scenarioTitle`, resolved from the session's **pinned** (id, version) in the registry, falling back to `Interactive story` when there is no metadata. Stored event responses and historical sessions are not rewritten, and the reader's own view DTO is unchanged.

### Web

- `use-scenario-catalogue.ts` loads the catalogue once per account/auth session (scope-guarded like the library; aborted on unmount or auth change) and again only on a manual **Try again**. `scenario-catalogue.tsx` renders one accessible card per entry (`aria-label="Start story: <title>"`) with loading, empty and error states. A catalogue failure does not affect "Your stories".
- `use-start-story.ts` captures one immutable command `{ scenarioId, scenarioVersion, idempotencyKey }` from the clicked card. While it is in flight or awaiting a manual retry, every card is disabled and `start` is ignored; **Try again** resends that exact command even if the catalogue has since been refreshed with a newer version or without that story. Single-flight, deadline, auth-epoch and unmount protection are unchanged.
- The browser title map was removed; titles come from `scenarioTitle` (summaries) and the catalogue (cards). `scenario-boundary.test.ts` fails if web sources import API/scenario modules or hardcode a scenario id.

### Tests and commands

```bash
pnpm --filter @book/api test                                              # registry, requests, controller specs
pnpm --filter @book/api test:integration test/integration/interactive     # incl. interactive-catalogue (versions, key reuse, concurrency, titles) and HTTP
pnpm --filter @book/web test
```

### Phase 6.1 limitations

- The reader page header still shows the fixed text "The Last Delivery": the session view DTO (and its stored responses) has no title, and adding one was out of scope. It must be addressed before a second scenario is published.
- Catalogue entries are one per scenario (latest version only); there is no way to start an older published version from the UI, only through the API.
- Title and synopsis are English-only (`language` is currently always `en`); there is no localisation, ordering or featured-story control beyond sort-by-id.
