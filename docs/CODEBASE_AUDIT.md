# StoryMe Codebase Audit

Audit date: 2026-07-23. Findings come from controllers, Next.js route files, Prisma schema and
runtime delegate use, service/module wiring, providers, storage, tests, and package/deployment
configuration. Historical design documents were used only to find inconsistencies.

## Summary and implemented product

StoryMe already has a strong small-production backend: real JWT sessions, ownership checks,
verification/recovery, BullMQ with separate API/worker entrypoints, transactional outbox
scheduling, fenced `GenerationRun` heartbeat/recovery, cancellation, resumable claim-scoped
artifacts, idempotent credits, provider limits, one-time Stripe Checkout, and authenticated PDF
delivery. Next.js implements auth/recovery, library, book create/edit/generate/cancel/retry,
diagnostics/PDF download, credits, and Checkout return flows. Photos are validated, re-encoded
without metadata, versioned, hashed, and stored through local/S3/R2 drivers. Story,
character-profile, and image generation have deterministic mocks and OpenAI implementations;
layout/PDF publication is deterministic.

The main risks are maintainability concentrated in three large units, compatibility/schema
surface implying nonexistent product features, no complete privacy-erasure workflow, diagnostics
shown to every authenticated owner, and documents mixing current and superseded phases.

## Actual routes

All API routes have `/api` prefix.

| Area    | Routes                                                                                                                                                                                                                                                                                                               |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Health  | `GET /health`                                                                                                                                                                                                                                                                                                        |
| Auth    | `POST /auth/register`, `POST /auth/login`, `POST /auth/refresh`, `POST /auth/logout`, `GET /auth/me`, `POST /auth/verify-email`, `POST /auth/resend-verification`, `POST /auth/request-password-reset`, `POST /auth/reset-password`                                                                                  |
| Books   | `GET /books`, `POST /books`, `GET /books/:id`, `PATCH /books/:id`, `DELETE /books/:id`, `POST /books/:id/child-photo`, `GET /books/:id/pdf/preview`, `POST /books/:id/generate`, `POST /books/:id/retry-generation`, `POST /books/:id/regenerate`, `POST /books/:id/cancel`, `GET /books/:id/generation-diagnostics` |
| Credits | `GET /credits/balance`, `GET /credits/transactions`                                                                                                                                                                                                                                                                  |
| Billing | `GET /billing/packages`, `POST /billing/checkout`, `GET /billing/checkout/:sessionId/status`, `POST /billing/webhook`                                                                                                                                                                                                |

Health and the signature-checked Stripe webhook are public. Feature ownership derives from the
authenticated user. Frontend routes are `/`, `/register`, `/login`, `/verify-email`,
`/forgot-password`, `/reset-password`, `/dashboard`, `/dashboard/books/new`,
`/dashboard/books/[id]`, `/dashboard/credits`, `/billing/success`, and `/billing/cancel`. There is
no reader, public share, settings/profile, child-profile, admin, subscription, or page-editor
route.

## Pipeline and state

Scheduling atomically changes Book generation state, creates a queued `GenerationRun` with
immutable input snapshot/hash, charges one credit, and creates an outbox event. Dispatch enqueues
the stable run ID. The worker claims `queued -> running`, increments the fence, heartbeats,
validates the snapshot, and performs:

1. character profile and optional sheet (`char_build`);
2. one story result containing story/page plans, text, illustration plan and preview
   (`story_plan`, with AgentLog labels for `page_plan`, `story_draft`, `illust_plan`,
   `preview_ready`);
3. claim-scoped image reuse/copy/generation (`image_gen`);
4. deterministic layout (`layout`);
5. claim-scoped PDF render/publication (`pdf_render`).

The orchestrator persists `Book.status=layout`, then the coordinator atomically applies
`running -> completed` with `Book -> complete` and published claim pointers, or `running ->
failed` with `Book -> failed`, active-pointer removal, and idempotent refund. Invalid snapshots,
exhausted retries, and abandoned runs use the same fenced failure mechanism. Cancellation moves
queued/running to `cancelled`, increments the fence, suppresses pending outbox dispatch, sets
Book cancelled, and refunds once. `partial` and many fine-grained Book statuses are not written.

## Sources of truth

- **Book:** owned product aggregate/current presentation. `activeRunId` mirrors the active run;
  `publishedRunId` plus fencing version identifies the last successful publication.
  `lastGenerationInputHash` and namespace identify resumable JSON. Book status alone never proves
  worker ownership.
- **GenerationRun:** authoritative dispatch, snapshot, status, retry lineage, heartbeat and fence.
  Only exact `(runId, fencingVersion)` may write; terminal run/Book changes are transactional.
- **Artifacts:** bytes are authoritative only through Book namespace pointers. Run ID without
  fencing version is insufficient. Legacy positional keys remain for old rows.
  `previewPdfUrl` is a marker/key, not authorization.
- **GenerationJob:** best-effort legacy diagnostics mirror. Several update failures are swallowed;
  it cannot drive correctness.
- **Credits:** `User.credits` is current balance; `CreditTransaction` is audit/idempotency ledger.

## Large units to split

- `agent.service.ts` (~1,268 lines): references, character/story/image orchestration, layout/PDF,
  telemetry, resume diagnostics, and logs.
- `books.service.ts` (~938): CRUD, photos, policy, scheduling/execution, legacy mirror,
  cancellation, PDF access, and diagnostics.
- `book-detail-view.tsx` (~1,038): product controls, polling, diagnostics, asset keys, PDF, errors.
- Later candidates: `story-generation-provider.ts` (~773) and
  `claim-artifact-cleanup.service.ts` (~617).

Large test files reflect those units; split coverage with implementation boundaries.

## Legacy, unused schema, and inconsistencies

`GenerationJob` and its service/recovery are a runtime legacy mirror. Positional image/PDF keys
support pre-namespace rows. `partial` is reserved/unreachable; several step/status values describe
an older granular state machine. `AUTH_MODE=dev` is local-only. OAuth, alternate-provider,
subscription, sharing, notification, profile, and plan fields are placeholders.

No production Prisma delegate use was found for `ChildProfile`, `Upload`, `BookPage`,
`CharacterCard`, `BookSeries`, `WizardDraft`, `ShareLink`, `Subscription`, `UserBookState`, or
`Notification`. They remain in relations/migrations and require a data decision before removal.
`GenerationJob` is used, but only as the mirror. Active models include `User`, `RefreshToken`,
`Book`, `CreditTransaction`, `AgentLog`, `GenerationRun`, `OutboxEvent`, and `RecoveryLease`.

Documentation inconsistencies:

- `API_SPEC.md`, PRD/design and long phased docs mix planned endpoints/models with code. Child
  profiles, uploads, sharing, subscriptions, notifications, reader/editing and admin APIs are
  absent.
- The old status machine implies every stage is durable; code primarily persists layout/terminal
  status and logs other labels.
- README/local-demo use `IMAGE_GENERATION_PROVIDER_TOKEN`; code uses
  `IMAGE_GENERATION_PROVIDER`.
- README's “does not do” section contains implemented/crossed-out history.
- Some storage comments call claim-scoped helpers unused although current generation uses them.
- Deployment histories contain superseded statements in older phase sections and should remain
  historical rather than current specification.

## Archive/privacy exclusions

Never archive any `.env` other than literal `.env.example`; credentials; tokens/cookies; logs;
`apps/api/tmp`; photos/uploads/generated images/PDFs/artifacts; database/MinIO/Redis dumps,
backups, or volume data; dependencies/build/cache/coverage; editor/OS files; or prior archives.
The clean-archive script enforces this without opening excluded files.

Book deletion is only `deletedAt`; it does not erase related generated JSON/logs or local/cloud
artifacts.

## Production blockers and priorities

### P0

- Keep secrets/personal artifacts out of Git and review archives.
- For real deployment, configure shared durable S3/R2 for both image/PDF drivers, real email,
  strong independent JWT secrets, CORS/web URLs, PostgreSQL/Redis, migrations, and role preflight.
- Do not claim hard deletion before a complete retention/erasure workflow exists.

### P1

- Split the three large units without changing fencing, transactions, retry/cancel, credits, or
  publication.
- Migrate off `GenerationJob`; decide every unused Prisma model.
- Gate diagnostics/internal asset details for broader production.

### P2

- Add ownership-checked reader/images and progress based on real durable stages.
- Add Playwright journeys and privacy-safe request/run correlation.
- Design/test retention and hard-delete across DB, queue, local, and cloud storage.

### P3

- Only after reliability refactoring, add bounded page changes and deterministic checks with at
  most one optional validated repair.

Additional risks: console email makes real-user verification/recovery unusable; local storage is
not shared across deployed API/worker processes; no browser E2E proves full journeys; large units
and the legacy mirror increase regression surface.
