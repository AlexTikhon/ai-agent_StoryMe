# StoryMe: Current Product

This is the source of truth for what the repository implements now. The root PRD, API
specification, architecture, design, UX, and roadmap files preserve historical intent and future
design; they are not implementation contracts.

The repository ships two products behind one authentication layer: the personalized
children's-book generator (the sections from [Supported flow](#supported-flow) onward) and the
[interactive illustrated stories](#interactive-illustrated-stories) reader with its offline
authoring workflow. They share accounts, the API process and the web app, and nothing else: the
interactive engine uses no generation run, queue, worker, PDF or image provider.

## Supported flow

Users can register with email/password, verify email, log in, restore a session through a rotating
HttpOnly refresh cookie, and reset a password. They can create, edit, and soft-delete reusable
child profiles containing name and age, then explicitly apply one to a new or existing draft.
Applying a profile copies its current values into the Book; later profile edits/deletion never
rewrite a Book or GenerationRun. They can also create and edit an owned one-off book draft with
title, child name/age, language (`en`, `ru`, `pl`), theme, page count, optional lesson, and an
optional reference photo. `PRODUCT_MODE=home` is the default private-family mode: generation keeps
all provider and capacity guardrails but does not debit credits or expose purchasing. The opt-in
`demo` mode retains credit debits and Stripe purchase UI. Starting generation atomically creates a
run/outbox event and, in demo mode only, charges a credit. A separate BullMQ worker generates the
story, images, layout, and PDF. Before generation, the API can return a server-owned provider-call,
cost, and duration estimate and enforces configured hard limits before charging or scheduling. The detail screen
polls status and supports cancellation, retry from a failed run's immutable snapshot,
regeneration from current input, authenticated PDF download, version-checked text correction, and
explicitly confirmed image regeneration for one page of a completed book. A page text correction
reuses every published image, invokes no AI provider, charges no credit, and atomically republishes
the dependent layout/PDF. A page image regeneration first displays a server-owned one-credit
quote; only confirmation schedules the paid call, and failure preserves the book and refunds that
credit. Developer diagnostics and
intermediate technical details are opt-in through
`NEXT_PUBLIC_ENABLE_DEVELOPER_DIAGNOSTICS=true`; when disabled, the browser does not request
diagnostics. The ordinary progress banner reads a minimal owned `GenerationRun` projection and
shows only fenced stages the worker has durably entered, without internal logs or invented
percentages. Users can view their credit ledger and, when explicitly enabled, buy one-time
packages through Stripe Checkout.

JWT mode is the default. A local-only `dev` auth mode exists and must not be exposed publicly.

## Interactive illustrated stories

A signed-in reader plays a branching detective story. A deterministic engine validates and applies
every choice, stores each transition as an event, and serves a public view of the result. No
language model runs during play. Implementation detail lives in the
[engine document](../apps/api/docs/interactive-engine.md) and the
[authoring document](../apps/api/docs/interactive-authoring.md); a reproducible walkthrough is in
[interactive-demo.md](interactive-demo.md). Code is under
[apps/api/src/interactive/](../apps/api/src/interactive/) and
[apps/web/src/app/dashboard/interactive/](../apps/web/src/app/dashboard/interactive/).

### What the reader does

- **Published catalogue.** `GET /api/interactive/scenarios` lists each published scenario's latest
  version with a title, language and spoiler-free synopsis. The static registry in
  [scenarios/index.ts](../apps/api/src/interactive/scenarios/index.ts) is the only publication
  authority. One scenario is published: "The Last Delivery" (`warsaw-last-delivery` v1, English,
  eight scenes, three decision points, two endings).
- **Version-pinned sessions.** A session stores its scenario id and version, and its first event
  stores a hash of the definition. It never adopts a newer or edited definition; a version the
  build no longer ships is refused (`SCENARIO_VERSION_UNAVAILABLE`), not migrated.
- **Choices, knowledge, inventory, endings.** A choice is the only client input. Requirements
  (`playerKnows`, `hasItem`, `flag`, `notFlag`) and effects (`learnFact`, `npcLearns`, `giveItem`,
  `consumeItem`, `setFlag`) are a closed vocabulary with no expressions. Narration may only voice
  facts its speaker knows. Locked choices are absent from the response, a one-time item is
  consumed when used, and play stops at an ending.
- **Session library and resume.** Session creation is idempotent (a required key). The "Your
  stories" list shows in-progress and completed sessions; a reload or a link back to a session
  fetches the stored state and never creates one. A user may retain 50 sessions
  (`INTERACTIVE_MAX_SESSIONS_PER_USER`); there is no deletion yet.
- **Revision conflicts and immutable retries.** Each choice carries the revision the player saw
  and an idempotency key. The server locks the session row, so a stale revision is
  `409 REVISION_CONFLICT` and an identical retry returns the saved response without a second
  event. The reader holds one immutable command per choice: a lost response is recovered by a
  manual **Retry choice** that resends the identical command, and a conflict reloads the
  authoritative state and asks the player to choose again. Nothing is re-sent against a newer
  revision.
- **Presentation packs.** Artwork is selected by a separate pack, not by the scenario. `warsaw-noir`
  v1 maps each of the eight scenes to a local hand-authored SVG
  ([presentation/packs.ts](../apps/api/src/interactive/presentation/packs.ts), files in
  [apps/web/public/interactive/warsaw-noir/v1/](../apps/web/public/interactive/warsaw-noir/v1/)).
  Artwork failures do not block play: a metadata outage or a broken image file shows a text notice
  and a bounded manual reload while the story continues.

### Interactive API routes

All routes have the `/api` prefix, use `AuthModeGuard` plus a per-user, Redis-backed request budget
(fail-closed), validate input with strict schemas, and take the owner from the authenticated user.
A missing session and another user's session both return `404 SESSION_NOT_FOUND`. Routes are
derived from [interactive.controller.ts](../apps/api/src/interactive/interactive.controller.ts) and
[interactive-scenarios.controller.ts](../apps/api/src/interactive/interactive-scenarios.controller.ts).

| Method | Route                                    | Behavior                                                                      | Budget (`INTERACTIVE_*`) |
| ------ | ---------------------------------------- | ----------------------------------------------------------------------------- | ------------------------ |
| GET    | `/interactive/scenarios`                 | Published catalogue (`private, no-store`)                                     | `READ`                   |
| POST   | `/interactive/sessions`                  | Create a session; `idempotencyKey` required, `scenarioVersion` optional       | `CREATE`                 |
| GET    | `/interactive/sessions`                  | Owned session library, keyset pagination (`limit`, `cursor`)                  | `READ`                   |
| GET    | `/interactive/sessions/:id`              | Current public view of an owned session                                       | `READ`                   |
| GET    | `/interactive/sessions/:id/presentation` | Current scene's artwork metadata; `expectedRevision` required, stale is `409` | `READ`                   |
| GET    | `/interactive/sessions/:id/metadata`     | Title of the session's pinned scenario version                                | `READ`                   |
| POST   | `/interactive/sessions/:id/choices`      | Submit one choice (`choiceId`, `expectedRevision`, `idempotencyKey`)          | `CHOICE`                 |

Budgets are `INTERACTIVE_<KIND>_RATE_LIMIT_WINDOW_MS` and `..._MAX_ATTEMPTS`; defaults are in
`.env.example` and are private-pilot assumptions, not measured limits. Stable error codes are listed
in the engine document. Web routes: `/dashboard/interactive` (catalogue, "Your stories", explicit
**Start story**) and `/dashboard/interactive/[sessionId]` (the reader).

### Offline authoring and the human approval boundary

Authoring is a set of local commands with no endpoint, database, queue or editor UI:

| Command                                             | Purpose                                                                    |
| --------------------------------------------------- | -------------------------------------------------------------------------- |
| `pnpm author:interactive --mode mock`               | Brief to candidate, at most one generation and one repair, then validation |
| `pnpm playtest:interactive --candidate <file>`      | Play a candidate through the production engine; read-only                  |
| `pnpm preflight:interactive --candidate --approval` | Re-validate a candidate and check its approval record; read-only           |
| `pnpm eval:interactive:authoring:offline`           | Fixture evaluation of the authoring pipeline; no services, keys or network |

A successful run writes a `--review-required` directory: the normalized candidate, a validation
report, a human-readable review report, and an approval template that is `pending`. There is no
approve, promote or publish command. Publication is a manual sequence recorded in source control:
a person writes an approval record bound to the candidate's hash, the definition is committed as
an immutable versioned JSON file, and it is registered in `scenarios/index.ts` with its approval in
`scenarios/approvals.ts` and hand-written catalogue metadata. The registry
([guarded-registry.ts](../apps/api/src/interactive/publication/guarded-registry.ts)) refuses to
load a definition without a matching approved record. The sequence is specified in
[Publication boundary](../apps/api/docs/interactive-authoring.md#publication-boundary-manual-sequence).

Current status:

- **The Last Delivery** is published. It predates approval records and is pinned in
  [legacy-baseline.ts](../apps/api/src/interactive/scenarios/legacy-baseline.ts) by id, version and
  hash as existing content; no retrospective human approval is claimed. `SCENARIO_APPROVALS` is
  empty.
- **The Last Tram** (`warsaw-last-tram` v1, the bundled mock episode) is `REVIEW_REQUIRED`. It is
  not registered, not in the catalogue, and session creation for it returns
  `422 UNKNOWN_SCENARIO`. Its approval template is pending and preflight fails with
  `APPROVAL_PENDING`. See the [editorial review notes](../apps/api/docs/last-tram-editorial-review.md).
- **Real-model authoring quality is unverified.** The OpenAI mode (it needs `--allow-paid-calls`
  and an explicit model) is tested only against intercepted HTTP; whether a real model produces a
  valid candidate, and how often it needs repair, is unknown.

### Design trade-offs

- **Deterministic gameplay over runtime LLM narration.** Narration is accepted only if it equals the
  approved template text for the exact state
  ([domain/narration.ts](../apps/api/src/interactive/domain/narration.ts)), so a contradiction
  cannot be produced and any session can be replayed from its events. The cost is fixed prose that
  cannot react to anything the scenario did not anticipate. The `NarratorProvider` seam exists
  ([narrator/narrator.ts](../apps/api/src/interactive/narrator/narrator.ts)) but only the mock
  implementation is wired; see
  [Narration and its limits](../apps/api/docs/interactive-engine.md#narration-and-its-limits).
- **Static versioned publication over dynamic content management.** Scenarios are JSON files in
  source and are published by a code change, so a pinned session can always be replayed against
  the exact definition it started with ([registry.ts](../apps/api/src/interactive/scenarios/registry.ts)).
  The cost is that a new story or a fix needs a commit and a deploy; there is no in-app editor or
  hot publish.
- **Mechanical validity over prose quality.** Validation proves reachability, no dead ends, usable
  choices and that annotated facts are known by their speaker
  ([authoring/validate.ts](../apps/api/src/interactive/authoring/validate.ts)). It cannot show that
  prose is good, free of unannotated spoilers or suitable for an audience, because fact ids are
  assertions supplied by the author. A pass therefore means `REVIEW_REQUIRED`, and the human gate
  is the quality control. See the [authoring document](../apps/api/docs/interactive-authoring.md).
- **Local SVG packs over generated artwork.** Eight hand-authored files need no provider, cost or
  network, load deterministically, and are checked for scripts and external references
  ([presentation/presentation.ts](../apps/api/src/interactive/presentation/presentation.ts)). The
  cost is prototype-quality art, one panel per scene, files that are public static assets, and a
  pack that is chosen at read time rather than pinned to a session. See
  [Phase 4 notes](../apps/api/docs/interactive-engine.md#phase-4-illustrated-reader-presentation-packs).

### Interactive limitations

- No session deletion or retention; every session counts toward the per-user cap.
- Catalogue titles and synopses are English only; the catalogue shows each scenario's latest
  version, and older versions can be started only through the API.
- Request budgets and the cap are initial private-pilot assumptions. This document makes no
  deployment claim for the interactive product.
- An approval record is a human-authored attestation, not an authenticated signature.
- There is no web preview of drafts; reviewers use the offline playtest.

## API routes

All routes have the `/api` prefix. The interactive routes are listed in
[Interactive API routes](#interactive-api-routes).

| Method           | Route                                                              | Behavior                                 |
| ---------------- | ------------------------------------------------------------------ | ---------------------------------------- |
| GET              | `/health`                                                          | PostgreSQL and Redis health              |
| POST             | `/auth/register`                                                   | Create account and refresh cookie        |
| POST             | `/auth/login`                                                      | Authenticate and set refresh cookie      |
| POST             | `/auth/refresh`                                                    | Rotate refresh token                     |
| POST             | `/auth/logout`                                                     | Revoke token and clear cookie            |
| GET              | `/auth/me`                                                         | Current authenticated user               |
| POST             | `/auth/verify-email`                                               | Consume verification token               |
| POST             | `/auth/resend-verification`                                        | Request verification message             |
| POST             | `/auth/request-password-reset`                                     | Request reset without enumeration        |
| POST             | `/auth/reset-password`                                             | Consume reset token                      |
| GET/POST         | `/child-profiles`                                                  | List active owned profiles / create one  |
| GET/PATCH/DELETE | `/child-profiles/:id`                                              | Read, edit, or soft-delete owned profile |
| GET/POST         | `/books`                                                           | List owned books / create draft          |
| GET/PATCH/DELETE | `/books/:id`                                                       | Read, edit, or soft-delete an owned book |
| POST             | `/books/:id/child-photo`                                           | Validate, re-encode, and store photo     |
| POST             | `/books/:id/generate`                                              | Schedule initial generation              |
| POST             | `/books/:id/retry-generation`                                      | Resume failed snapshot                   |
| POST             | `/books/:id/regenerate`                                            | Generate from current input              |
| POST             | `/books/:id/cancel`                                                | Fence/cancel active run and refund once  |
| GET              | `/books/:id/generation-estimate`                                   | Server-owned provider-work estimate      |
| GET              | `/books/:id/generation-progress`                                   | Minimal owned durable progress           |
| GET              | `/books/:id/generation-diagnostics`                                | Owned run/artifact diagnostics           |
| GET              | `/books/:id/pdf/preview`                                           | Ownership-checked PDF bytes              |
| GET              | `/books/:id/images/:imageId`                                       | Ownership-checked published image bytes  |
| PATCH            | `/books/:id/pages/:pageNumber/text`                                | Versioned page text edit and PDF rebuild |
| POST             | `/books/:id/pages/:pageNumber/image-regeneration-quote`            | Quote one page image without charging    |
| POST             | `/books/:id/pages/:pageNumber/image-revisions/:revisionId/confirm` | Confirm charge and queue revision        |
| GET              | `/books/:id/page-image-revisions/:revisionId`                      | Read owned durable revision status       |
| GET              | `/credits/balance`                                                 | Canonical owned balance                  |
| GET              | `/credits/transactions`                                            | Cursor-paginated owned ledger            |
| GET              | `/billing/packages`                                                | Server package catalog                   |
| POST             | `/billing/checkout`                                                | Hosted one-time Checkout session         |
| GET              | `/billing/checkout/:sessionId/status`                              | Durable grant state                      |
| POST             | `/billing/webhook`                                                 | Stripe-signature-authenticated webhook   |

The webhook is intentionally public; health is public. Other feature routes use authentication,
and ownership comes from the authenticated user rather than client-supplied user IDs.

## Frontend routes

`/`, `/register`, `/login`, `/verify-email`, `/forgot-password`, `/reset-password`, `/dashboard`,
`/dashboard/child-profiles`, `/dashboard/books/new`, `/dashboard/books/[id]`,
`/dashboard/credits`, `/billing/success`, and
`/billing/cancel`. The interactive reader adds `/dashboard/interactive` and
`/dashboard/interactive/[sessionId]` (see [Interactive illustrated stories](#interactive-illustrated-stories)).

The completed-book detail screen has an authenticated in-browser reader for the published cover,
every generated story page, and the back cover. It lazily fetches one owned published image at a
time without exposing storage keys. Library cards show the ownership-checked published cover when
one exists and a neutral placeholder otherwise. A story page can be edited in place; the UI sends
its expected version, explains that illustrations are unchanged and no credit is charged, and
refreshes the reader from the atomically republished book. It can also request a one-page image
quote, show the exact credit charge before confirmation, poll the durable revision, and refresh
only after atomic publication. With developer diagnostics explicitly enabled,
the book detail screen shows internal image asset keys and intermediate pipeline details.

## Providers and storage

- Story, character-profile, and image providers each support deterministic mock or OpenAI.
- Email supports console or Resend. Stripe one-time billing is disabled by default.
- PDF and image storage support local, S3, or R2. Images have a separate driver selector but reuse
  `PDF_STORAGE_*` bucket credentials.
- Automated tests use mock/fake providers and make no real OpenAI, Stripe, Resend, S3, or R2 call.

Local processed photos and generated images live under `apps/api/tmp/images/`; local PDFs live
under `apps/api/tmp/books/`. Claim-scoped keys carry book, run, and fencing identity. Cloud
drivers use equivalent bucket keys. PDFs are not exposed through a public static directory.

## Actual generation workflow

`HTTP schedule -> PostgreSQL transaction (Book + GenerationRun + credit + outbox) -> outbox
dispatcher -> BullMQ/Redis -> worker claim/heartbeat/fencing -> deterministic pipeline ->
transactional terminal publication`.

The content stages are character profile/sheet, one story-provider result containing story plan,
page plan, story text, illustration plan and preview, deterministic quality review, an optional
single bounded repair attempt for repairable findings, image generation/reuse, deterministic
layout, and PDF publication. The current orchestrator orders preparation, character,
story/quality, image, and publication boundaries. Nest owns the stage/service composition.
`GenerationPublicationService` owns deterministic layout, fenced candidate persistence,
claim-scoped PDF rendering, resume diagnostics, and outcome assembly; `GenerationRunCoordinator`
still exclusively owns the transactional `complete`/`failed` transition;
cancellation writes `cancelled`. The authoritative `GenerationRun.currentStep` separately records
the major stages the worker actually enters: `char_build`, `story_plan`, `qa_review`, `image_gen`,
`layout`, and `pdf_render`. Finer Book/step enum values remain diagnostic or historical and are
not fabricated as progress. `partial` is unreachable. Deterministic quality errors stop the run
before page-image generation and persist only typed, privacy-safe findings.

`GenerationRun` (`queued`, `running`, then `completed`, `failed`, or `cancelled`) is the durable
execution source of truth. Every write verifies `(runId, fencingVersion)`. Reuse requires matching
input identity and valid claim-scoped bytes. Success atomically advances the published pointer;
a later failed/cancelled regeneration preserves the previous publication.

### Publication and execution guarantees (September 2026)

Claim update/read runs in a short PostgreSQL transaction holding the row lock; the returned
delivery token is verified. External provider and storage calls run outside transactions.
Candidate character identity, accepted story, layout, and each stored raster are saved in
`Book.generationCheckpoint`. Reader fields remain on the previous publication until the winning
fence atomically publishes all content, image manifest, page versions, and PDF pointer. A full
regeneration replaces page-image overrides and advances page versions above the previous maximum.
Text edits intentionally keep illustrations; image revisions change one illustration and its PDF.

API estimation and worker preparation use the same read-only artifact inspection. Reuse requires
input/provider/model/prompt compatibility, validated structured outputs, and decoded PNG/JPEG
bytes matching the checkpoint checksum. Copy-forward and PDF rendering recheck image identity.
Decoding is limited to 20 MiB compressed bytes and 16,777,216 pixels per single-frame image.
Required publication images never silently become PDF placeholders. Explicit standalone preview
rendering can still use placeholders; deterministic mocks produce real, small PNGs.

Runs persist versioned execution authorization, provider identities, configured cost assumptions,
limits, and the accepted estimate. Workers reject configuration drift and increased work before
generation. Durable logical-operation reservations and HTTP-attempt reservations precede dispatch;
paid allowances are also checked by operation category, so mock work cannot authorize extra paid
work. Reservations survive redelivery. An interrupted remote operation is `unknown`, not free;
at most two logical invocations per operation/asset are allowed within the original budget, and
story repair has at most one. Provider success alone does not establish a reusable stored artifact.
This is not exactly-once remote execution: a provider may continue or charge after cancellation.

`GENERATION_HEARTBEAT_MS` defaults to five seconds independently of the thirty-minute lease.
`GENERATION_RUN_DEADLINE_MS` defaults to 45 minutes from run creation, including queue time and
redeliveries. Cancellation interrupts local waits and suppresses new dispatch after ownership is
lost; in-flight remote cancellation is best effort. Refunds remain transactional and idempotent.
Page-image revisions allow one durable dispatch across deliveries and persist provider/model/prompt
and cost identity; incompatible or legacy paid quotes fail safely and need a fresh quote.

The library returns `BookSummaryDto`. Reader responses include `publishedEdition`; image/PDF
requests can pin that edition and receive a conflict if it changed. The web reader revokes old
image blobs, reloads on edition change, and bounds its page index after page-count changes.

### Artifact writes and permanent deletion

Worker writers (generation, page-image revision, snapshot backfill) are covered by run/revision
fencing plus the `hasActiveBookWork` check. Three API-side writers had no such coordination and now
register in `book_artifact_write_intents` through `BookArtifactWriteCoordinator`: the lazily built
cover thumbnail, the child-photo upload, and the text-edit candidate PDF.

- **Admission.** `admit()` inserts an `active` intent in a short transaction that first takes
  `SELECT … FOR SHARE` on the live (`deleted_at IS NULL`) Book row. Hard-delete `request()`
  tombstones that same row, so admission and tombstone are totally ordered: an intent either
  committed first (and deletion must account for it) or admission fails with
  `BookArtifactWritesClosedError` (the thumbnail is then served uncached; upload and text edit
  answer 404). A second database check before writing would not be enough; the lock is.
- **Publication.** Storage I/O runs outside any transaction. The intent is consumed
  (`deleteMany … state = active`, must affect one row) inside the same transaction that publishes
  the artifact, so a reaped (fenced) writer can never publish and a committed publication leaves no
  record.
- **Cleanup.** A writer that did not publish calls `discard()`: the intent becomes
  `cleanup_pending` (the durable cleanup record), the exact artifacts are deleted and verified
  absent, then the record is removed. If the record is already gone, nothing is deleted, so an
  ambiguous commit acknowledgement cannot delete a published artifact. Storage failure leaves the
  record; `recoverStale()` retries it from the leased `GenerationRunRecoveryService` pass.
- **Deletion.** `process()` requires `countBlockingWriters() == 0` **before** the storage sweep
  (otherwise `retry_pending` with `BOOK_WRITERS_STILL_ACTIVE`). Because admission is closed, that
  count can only fall. The existing sweep deletes and re-lists both drivers; only after it reports
  complete does the finalization transaction delete the redundant cleanup records and the Book.
  Idempotent requests, ownership checks, `retry_pending` retry and refund semantics are unchanged.
- **Crashes and stalls.** A crashed writer leaves an `active` intent. Until its lease
  (`BOOK_ARTIFACT_WRITE_LEASE_MS`, default 10 minutes) expires, deletion stays `retry_pending`.
  After expiry the intent is _reaped_: fenced into `cleanup_pending`, so its publication
  transaction can no longer succeed, and the sweep or recovery removes its artifacts.
  A crashed deletion simply resumes from `processing`.
- **Limitations.** Reaping is a liveness decision, not proof that a stalled process stopped. A
  writer stalled beyond the lease whose storage request lands _after_ the reaper's verified cleanup
  (or after deletion completes) can still leave one orphan object; its own post-write fence check
  removes it only if that process survives and the record still exists. Cloud storage has no
  cross-object transaction, so "absent" means a fresh verification at that moment. No
  application-level cap on a single storage request's duration is added here. Recovery is
  periodic (the existing recovery interval) and also runs inside every deletion retry; there is no
  dedicated scheduler.

Operational notes: apply the additive migration `20260914090000_book_artifact_write_intents` before
starting the updated API/worker. The old binary does not write intents, so during a rolling
deploy an old API instance is not coordinated with deletion until it is replaced.

### Quality scope and provider output

Story and character Chat Completions use strict Structured Outputs with local schema/business
validation, retaining the existing models and endpoint. Output limits are 10,000 tokens for story
and 2,000 for character. Refusal, truncation, and schema failures remain distinct; token usage is
reported even for refusal/truncation responses. See the
[official Structured Outputs guide](https://developers.openai.com/api/docs/guides/structured-outputs).
`CHARACTER_FALLBACK_POLICY=required` prevents paid personalization from silently becoming a generic
fallback; `allow_degraded` explicitly permits it, with publication degradation recorded.

Language checks inspect actual prose, independently of metadata. The conservative classifier needs
at least 80 letters and uses script proportions or strongly dominant English/Polish function words.
Short or ambiguous samples are unknown; it is not a calibrated fluency or translation score, and
Cyrillic does not distinguish Russian from all other Cyrillic languages. Common Russian/Polish name
suffixes are tolerated, without claiming complete morphological analysis. Predefined lessons have
canonical `lesson:sharing`, `lesson:mistakes`, and `lesson:patience` identities and localized labels;
arbitrary translated free-text lessons produce advisory mismatches rather than literal-equality
rejection. Offline fixtures exercise en/ru/pl, ages, themes, localized lessons, repeated prose,
plan/reader contradictions and instruction-like output containing forbidden links.

Structural checks and deterministic textual heuristics do not establish semantic coherence,
comprehensive content safety, photo likeness, or visual consistency. No semantic/vision judge is
enabled and no optional judge call is hidden in the budget. Human-reviewed semantic and visual
calibration remains outstanding before introducing any such blocking score. Prompt identity checks
verify prompt construction only. The bounded repair remains opt-in and budgeted.

### Migration and CI compatibility

Five additive migrations introduce candidate checkpoints/execution ledgers, page-revision dispatch
and recovery state, published manifests, and page-revision execution identity. Legacy checkpoints retain their
original namespace and are marked legacy; existing published pointers remain readable and receive
confirmed manifests on subsequent publication. Historical mixed editions cannot be reconstructed
from an overwritten legacy Book row. Legacy runs without authorization receive a conservative
worker authorization before dispatch. Apply migrations before starting the updated API/worker;
no destructive reset is needed.

Only CI is enabled: lint, typecheck, build, unit tests, offline evaluation, and isolated PostgreSQL/
Redis integration tests using synthetic data and mock providers. The integration runner refuses
other targets than `127.0.0.1:5440/storyme_e2e` and Redis `127.0.0.1:6380/15`. Migration/deployment/
backup workflows remain disabled. Repository owners must configure required branch checks
`Checks` and `Isolated integration`; workflow files cannot enforce branch protection by themselves.

## Implemented and unimplemented

Implemented: JWT auth/recovery, ownership enforcement, owner-scoped reusable child-profile CRUD,
explicit profile-to-Book name/age snapshotting with manual one-off compatibility, safe
child-photo processing, draft CRUD
and soft-delete, durable queued generation, fencing/heartbeat/recovery, cancellation,
retry/resume, idempotent charges/refunds, one-time credit purchases, provider limits, local/S3/R2
artifacts, authenticated PDF and published-image access, an authenticated completed-book reader,
published cover thumbnails in the library, durable user-facing generation progress, and
versioned one-page text correction and explicitly confirmed one-page image regeneration with
failure-safe PDF republication, an explicit deterministic story-quality contract with bounded
one-pass repair, privacy-safe request/run
correlation, Playwright coverage of the real local API/worker boundary, and explicit owned,
fenced, retriable hard deletion across PostgreSQL and configured artifact storage.

Provider diagnostics include request-local HTTP attempt/retry/rate-limit/timeout metrics and actual
OpenAI text token counts when returned by the provider. Unknown metrics remain absent. Estimated
cost stays separate from the existing actual-cost fields. The process-wide image limiter retains
global operator counters, but book/run diagnostics use only metrics emitted by each logical call.

Not implemented: OAuth flow, subscriptions/customer portal, public sharing, reusable child-profile
photos, automatic retention scheduling, and role-based admin authorization for diagnostics.
The reader follows published artifact availability rather than current run status, so a previous
complete publication remains readable while regeneration is running, failed, or cancelled. The web
diagnostics UI is environment-gated and defaults off; the owned diagnostics API contract remains
available.

Known limitations: provider cost remains an operator-configured estimate because responses do not
supply an authoritative per-call currency amount, so `AgentLog.costUsd` remains null on this path.
Token usage is absent for mocks and provider responses without usage metadata;
`BooksService` is now a compatibility facade over CRUD, asset, diagnostics, generation scheduling,
and generation execution services; the legacy `GenerationJob` runtime and Prisma model have been
removed in favor of authoritative `GenerationRun`; Book soft-delete does not erase artifacts and
must not be confused with the separate irreversible hard-delete workflow; local storage cannot
serve separately deployed API/worker processes; console email does not deliver production mail.
English, Russian, and Polish mock stories are deterministic and localized. Character profiles now
carry a canonical versioned appearance fingerprint and immutable visual bible shared by the
character reference and every scene-separated illustration prompt. Structured layout quality is
validated before PDF rendering, and `pnpm eval:story:offline` runs the synthetic good/malformed
quality corpus without API keys or external traffic. Bounded story repair exists but is
disabled by default and requires an explicitly configured repair-capable story provider and
paid-call budget.

The Phase 14A schema/runtime/privacy decision is documented in
[PHASE_14_CHILD_PROFILE_AUDIT.md](PHASE_14_CHILD_PROFILE_AUDIT.md), and the route contract is in
[CHILD_PROFILES_API.md](CHILD_PROFILES_API.md). The code-derived model/enum retention decisions are documented in
[PHASE_7_SCHEMA_AUDIT.md](PHASE_7_SCHEMA_AUDIT.md); Phase 7 intentionally includes no destructive
schema migration.

## Local run and validation

Prerequisites: Node 20+, pnpm 9+, Docker, and Docker Compose.

```text
pnpm install
docker compose up -d postgres redis
```

Create untracked `apps/api/.env` from the root `.env.example`, keep generation providers in mock
mode, then run:

```text
pnpm --filter @book/api prisma:generate
pnpm --filter @book/api prisma:migrate:deploy
pnpm --filter @book/api dev
pnpm --filter @book/api dev:worker
pnpm --filter @book/web dev
```

See [local-demo.md](local-demo.md) for the walkthrough. Validation commands are:

```text
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm --filter @book/api test:integration
```

The production web build requires a valid `NEXT_PUBLIC_API_URL` ending in `/api`. Leave
`NEXT_PUBLIC_ENABLE_DEVELOPER_DIAGNOSTICS` unset/false for the ordinary product UI; enable it only
for trusted developer builds.
